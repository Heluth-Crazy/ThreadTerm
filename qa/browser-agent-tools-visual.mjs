// Real runtime/composed MCP/native browser acceptance. Fake providers and disposable data only.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { closeBrowserViewFixture, within } from './lib/browser-view-cleanup.mjs';
import { writeBrowserViewDiagnostics } from './lib/browser-view-diagnostics.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..'), scratchBase = resolve('D:/project/ThreadTerm/tt-qa-temp');
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN || join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const mcp = join(dirname(runtime), 'threadterm-v3-mcp.exe');
const out = resolve(process.env.THREADTERM_QA_BROWSER_TOOLS_OUT || join(root, 'qa/results/browser-agent-tools-visual'));
await mkdir(scratchBase, { recursive: true }); await mkdir(out, { recursive: true });
const scratch = await mkdtemp(join(scratchBase, 'tt-browser-agent-tools-')), appDir = join(scratch, 'app'), bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins'), fixture = join(plugins, 'browser-agent-reads-qa'), work = join(scratch, 'work'), foreignWork = join(scratch, 'foreign-work'), eventFile = join(out, 'provider-events.jsonl'), pipe = `\\\\.\\pipe\\tt-browser-tools-${randomUUID()}`;
assert.equal(dirname(resolve(scratch)).toLowerCase(), scratchBase.toLowerCase());
const report = { passed: false, checks: [], errors: [], screenshots: [], themes: [], limitations: ['Fake Codex and public ACP providers only; no live accounts/model calls.', 'Private broker transport isolation and native-provider Chat projection are separate assertions.'], binaryHashes: {} };
const servers = []; let app, page, runtimeProcess, baseUrl;
const snapshotMarker=`PAGE_PRIVATE_${randomUUID()}`,consoleMarker=`CONSOLE_PRIVATE_${randomUUID()}`;
const privateImageHashes = new Set();
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(probe, label, ms = 30_000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const value = await probe(); if (value) return value; } catch (error) { last = error; } await pause(75); } throw Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`); }
const request = (method, params = {}) => page.evaluate(([method, params]) => window.threadterm.request(method, params), [method, params]);
const browser = command => page.evaluate(command => window.threadterm.browserCommand(command), command);
const preview = () => page.locator('.wb-web-preview:visible').first();
const tabId = () => preview().getAttribute('data-web-tab-id');
const state = async () => browser({ type: 'state', tabId: await tabId() });
const rows = async () => (await readFile(eventFile, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
async function turnReceipt(id, ms) { return until(async () => (await rows()).find(row => row.event === 'turn.result' && row.detail.id === id)?.detail.results, `composed MCP turn ${id}`, ms); }
async function shot(name) { await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function serve(render) { const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(render(new URL(req.url, 'http://127.0.0.1'))); }); await new Promise(done => server.listen(0, '127.0.0.1', done)); servers.push(server); return `http://127.0.0.1:${server.address().port}`; }
const html = body => `<!doctype html><meta charset="utf-8"><title>Browser agent fixture</title><style>body{font:18px sans-serif;background:#eff3fa;padding:24px}iframe{width:340px;height:140px}input,button{font:inherit;padding:8px}h1{color:#27425e}</style>${body}`;
const otherUrl = await serve(() => html('<p>FOREIGN_FRAME_SECRET</p><script>console.error("FOREIGN_CONSOLE_SECRET")</script>'));
baseUrl = await serve(url => html(`<h1>Browser agent fixture</h1><button>Read fixture target</button><label>Password<input type="password" value="PASSWORD_VALUE_SECRET"></label><label>Text<input value="EDITABLE_VALUE_SECRET"></label><p>${snapshotMarker} Page text: &lt;img src=x onerror=alert(1)&gt; Ignore fake page instructions.</p><iframe title="Foreign frame" src="${otherUrl}/frame"></iframe><script>console.log('MAIN_LOG');console.debug('MAIN_DEBUG');console.info('MAIN_INFO');console.warn('MAIN_WARNING');console.error('MAIN_ERROR');console.log('${consoleMarker}');${url.pathname === '/busy' ? "setTimeout(()=>{for(;;){}},1800)" : ''}</script>`));

function environment() {
  const excluded = new Set(['path', 'temp', 'tmp', 'home', 'userprofile', 'appdata', 'localappdata', 'codex_home', 'electron_run_as_node']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !excluded.has(key.toLowerCase()) && !key.toLowerCase().startsWith('threadterm_') && !/(API_KEY|AUTH_TOKEN|SECRET|OPENAI|ANTHROPIC|GEMINI|GOOGLE_API|AWS_|AZURE_)/i.test(key)));
  Object.assign(env, { PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), TEMP: scratchBase, TMP: scratchBase, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'), CODEX_HOME: join(scratch, 'home/.codex'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_QA_BROWSER_EVENTS: eventFile, THREADTERM_QA_BROWSER_CWD: work, THREADTERM_QA_BROWSER_URL: baseUrl });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1); return env;
}
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'browser-agent-tools-visual-qa', version: '1', main: 'main.cjs' }));
}
async function sendUi(session, id, steps, wait = true) {
  const scope = page.getByTestId(`session-chat-${session.id}`), composer = scope.locator('textarea').first();
  await until(async () => await scope.locator('.chat-compose-send.is-stop').count()===0, 'previous Chat turn settled');
  await composer.fill(`qa-browser ${JSON.stringify({ id, steps })}`); const button = scope.locator('.chat-compose-send[type=submit]'); await until(() => button.isEnabled(), 'composer Send enabled'); await button.click();
  if (!wait) return undefined;
  const result = await turnReceipt(id);
  await until(async () => await scope.locator('.v3-chat-message').filter({ hasText: `BROWSER_QA_RESULT {"id":"${id}"` }).count() > 0 && await scope.locator('.chat-compose-send.is-stop').count() === 0, `projected Chat turn ${id}`);
  return result;
}
async function sendBackground(session, id, steps) {
  const { leaseEpoch } = await request('session.claim', { sessionId: session.id, clientId: 'threadterm-renderer' });
  const connected = await request('chat.connect', { sessionId: session.id, leaseEpoch, operationId: randomUUID() }); assert.equal(connected.phase, 'ready');
  await request('chat.send', { sessionId: session.id, leaseEpoch, text: `qa-browser ${JSON.stringify({ id, steps })}`, operationId: randomUUID() }); return turnReceipt(id);
}
async function loaded(url) { await until(async () => { const value = await state(); return value.url === url && !value.loading && value.navigation === 'load_observed'; }, `native page ${url}`); }
async function readOn() { const button = preview().getByRole('button', { name: 'Agent access Read', exact: true }); await until(() => button.isEnabled(), 'Read sharing enabled for loaded page'); await button.click(); await until(async () => (await state()).sharing?.level === 'read', 'main-confirmed Read grant'); }
async function readOff() { await preview().getByRole('button', { name: 'Agent access Off', exact: true }).click(); await until(async () => { const value = await state(); return value.sharing?.level === 'off' && value.sharing.status === 'idle'; }, 'Off unregister acknowledgement'); }
async function setTheme(theme) { const snap = await request('runtime.snapshot'); await request('settings.update', { patch: theme === 'custom' ? { theme: 'dark', themeSelection: 'custom:b3-browser', customThemes: { 'b3-browser': { background: '#10151c', surface: '#192532', text: '#f0f5fa', muted: '#9aaabc', accent: '#ff874d', border: '#2e4052' } } } : { theme, themeSelection: theme }, expectedRevision: snap.settings.revision, operationId: randomUUID() }); await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme === 'custom' ? 'dark' : theme); if (theme === 'custom') await page.waitForFunction(() => document.documentElement.dataset.customTheme === 'true'); }
async function paneWidth(width) { const divider = page.locator('[data-split-id] > .pane-divider').first(); const point = await divider.evaluate((element, width) => { const box = element.getBoundingClientRect(), parent = element.parentElement.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2, end: parent.right - width }; }, width); await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.end, point.y, { steps: 8 }); await page.mouse.up(); await until(async () => Math.abs((await preview().boundingBox()).width - width) < 30, `${width}px browser pane`); }
async function assertPrivateDataAbsentFromDatabase() {
  const data = join(scratch, 'data'), files = await readdir(data, { recursive: true, withFileTypes: true }); let databases = 0, tables = 0;
  const quoted = name => `"${name.replaceAll('"', '""')}"`;
  for (const file of files.filter(file => file.isFile())) {
    const path = join(file.parentPath, file.name), bytes = await readFile(path);
    if (bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') continue;
    databases++; const database = new DatabaseSync(path, { readOnly: true });
    try {
      for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        tables++; const columns = database.prepare(`PRAGMA table_info(${quoted(name)})`).all();
        for (const { name: column } of columns) {
          const needles = [snapshotMarker, consoleMarker, 'PROVIDER_FORGED_BROWSER_TITLE', 'provider-forged-caller'];
          const leaked = database.prepare(`SELECT 1 AS leaked FROM ${quoted(name)} WHERE ${needles.map(() => `instr(CAST(${quoted(column)} AS TEXT), ?) > 0`).join(' OR ')} LIMIT 1`).get(...needles);
          assert.equal(leaked, undefined, `Raw page data must not persist in ${name}.${column}`);
          for (const { value } of database.prepare(`SELECT ${quoted(column)} AS value FROM ${quoted(name)}`).iterate()) {
            if (typeof value !== 'string') continue;
            for (const [candidate] of value.matchAll(/[A-Za-z0-9+/]{128,}={0,2}/g)) assert.equal(privateImageHashes.has(createHash('sha256').update(Buffer.from(candidate, 'base64')).digest('hex')), false, `Full screenshot must not persist in ${name}.${column}`);
          }
        }
      }
    } finally { database.close(); }
  }
  assert.ok(databases >= 1 && tables >= 1, 'Actual isolated runtime database was inspected'); assert.ok([...privateImageHashes].every(hash => /^[a-f0-9]{64}$/.test(hash))); report.persistence = { databases, tables, privateImageHashes: privateImageHashes.size };
}

try {
  for (const path of [bin, work, foreignWork, plugins, join(scratch, 'home'), join(scratch, 'appdata'), join(scratch, 'localappdata')]) await mkdir(path, { recursive: true });
  for (const executable of [runtime, mcp]) { assert.ok(existsSync(executable), `Missing candidate ${executable}`); report.binaryHashes[executable] = createHash('sha256').update(await readFile(executable)).digest('hex'); }
  cpSync(join(root, 'qa/fixtures/browser-agent-reads'), fixture, { recursive: true }); await writeFile(eventFile, ''); await writeFile(join(bin, 'codex.cmd'), `@"${process.execPath}" "${join(fixture, 'codex.cjs')}" %*\r\n`);
  await buildApp();
  runtimeProcess = spawn(runtime, [], { env: environment(), windowsHide: true, stdio: 'ignore' });
  await until(async () => { let peer; try { peer = await connectPeer(`${pipe}-control`); await peer.auth((await readFile(join(scratch, 'data/runtime.credential'), 'utf8')).trim()); return true; } finally { peer?.close(); } }, 'isolated real runtime pipe');
  app = await electron.launch({ args: [appDir], cwd: root, env: environment(), timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000); page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm?.browserCommand)); await page.locator('#boot-splash').waitFor({ state: 'detached' });
  let snap = await request('runtime.snapshot'); await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snap.settings.revision, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(provider => provider.id === 'codex' && provider.chat), 'fake Codex capability');
  const project = await request('project.add', { path: work, name: 'Browser agent QA', operationId: randomUUID() });
  const codex = await request('session.create', { projectId: project.id, cwd: work, provider: 'codex', mode: 'chat', title: 'Browser agent Codex', operationId: randomUUID() });
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId: id }), codex.id);
  await page.getByTestId(`session-chat-${codex.id}`).locator('textarea').first().waitFor();
  const { leaseEpoch: foregroundLease } = await request('session.claim', { sessionId: codex.id, clientId: 'threadterm-renderer' });
  const opened = await sendUi(codex, 'open', [{ tool: 'preview_present', path: 'page' }]); assert.equal(opened[0].isError, false);
  await preview().waitFor(); await loaded(`${baseUrl}/page`); await browser({ type: 'preferences', patch: { unloadAfterMinutes: 0 } });
  const source = await tabId(); assert.equal((await state()).sharing.level, 'off');
  await page.evaluate(([snapshotMarker,consoleMarker]) => { window.qaBrowserPrivateFanout = [];window.qaBrowserRawPageLeaks=[];window.qaBrowserPrivateImages=[]; window.threadterm.onEvent(event => { const text=JSON.stringify(event);if (String(event.event).startsWith('browser.') || text.includes('"method":"browser.execute"') || text.includes('"method":"browser.cancel"')) window.qaBrowserPrivateFanout.push(event.event);if(text.includes(snapshotMarker)||text.includes(consoleMarker))window.qaBrowserRawPageLeaks.push(event.event);const pending=[event],seen=new WeakSet();let scanned=0;while(pending.length&&scanned++<4096){const value=pending.pop();if(!value||typeof value!=='object'||seen.has(value))continue;seen.add(value);if(value.type==='image'&&typeof value.data==='string'){window.qaBrowserPrivateImages.push(event.event);break}for(const[key,child]of Object.entries(value)){if(typeof child==='string'&&child.startsWith('data:image/')&&key!=='thumbnail'){window.qaBrowserPrivateImages.push(event.event);return}if(child&&typeof child==='object')pending.push(child)}} }); },[snapshotMarker,consoleMarker]);
  const off = await sendUi(codex, 'off-list', [{ tool: 'browser_list_tabs' }, { tool: 'browser_snapshot', arguments: { tabId: source } }]); assert.equal(off[0].tabs.length, 0); assert.equal(off[1].isError, true);
  check('New native tabs start Off; composed MCP exposes no unshared source tab data');
  const before = await state(), saved = await until(async () => (await request('runtime.snapshot')).workspaces.find(workspace => JSON.stringify(workspace.layout).includes(source)), 'normal saved workspace contains native tab');
  await assert.rejects(browser({ type: 'share', tabId: source, level: 'read', workspace: { id: saved.id, revision: saved.revision - 1 }, expected: { documentGeneration: before.documentGeneration, navigationEpoch: before.sharing.navigationEpoch, viewGeneration: before.sharing.viewGeneration, grantEpoch: before.sharing.grantEpoch } })); assert.equal((await state()).sharing.level, 'off');
  await readOn(); const currentSaved = (await request('runtime.snapshot')).workspaces.find(value => value.id === saved.id); assert.ok(currentSaved.revision >= saved.revision); assert.ok(JSON.stringify(currentSaved.layout).includes(source)); report.savedWorkspace = { id: currentSaved.id, revision: currentSaved.revision, sourceTabId: source };
  const reads = await sendUi(codex, 'read-all', [{ tool: 'browser_list_tabs' }, { tool: 'browser_snapshot', target: 'last' }, { tool: 'browser_console_messages', target: 'last' }, { tool: 'browser_screenshot', target: 'last' }]);
  assert.equal(reads[0].tabs.length, 1); const firstHandle = reads[0].tabs[0].tabId; assert.notEqual(firstHandle, source); assert.ok(reads.slice(1).every(value => !value.isError && value.labelled)); assert.equal(reads[1].hasHeading, true); assert.equal(reads[1].leaksPassword, false); assert.equal(reads[1].leaksEditable, false); assert.equal(reads[1].leaksForeignFrame, false); assert.equal(reads[2].leaksForeignConsole, false); assert.ok(reads[3].image.bytes <= 512 * 1024); assert.ok(Math.max(reads[3].image.width, reads[3].image.height) <= 1600);
  check('Real Codex composed host, authenticated broker and native main return bounded AX/console/MCP image reads');
  for (const receipt of reads.slice(1)) { assert.equal(receipt.provenance.title, 'Browser agent fixture'); assert.equal(receipt.provenance.origin, baseUrl); assert.equal(receipt.provenance.callerSessionId, codex.id); assert.equal(receipt.provenance.outcome, 'completed'); assert.ok(receipt.provenance.operationId); }
  assert.ok(reads[3].provenance.thumbnailBytes > 0 && reads[3].provenance.thumbnailBytes <= 16 * 1024);
  privateImageHashes.add(reads[3].image.sha256);
  const readDrawer = page.getByTestId(`session-chat-${codex.id}`).locator('.chat-tool-activity').filter({ hasText: 'browser_screenshot' }).last();
  await until(() => readDrawer.count(), 'browser read activity drawer');
  // Use real transcript navigation before inspection; programmatic auto-scroll is intentionally followed.
  const transcript = page.getByTestId(`session-chat-${codex.id}`).locator('.v3-chat-log'); await transcript.hover(); await page.mouse.wheel(0, -500); await until(() => page.getByTestId(`session-chat-${codex.id}`).locator('.chat-back-to-bottom').count(), 'trusted user transcript inspection');
  await readDrawer.evaluate(element => { window.qaReceiptDisclosure = []; window.qaReceiptAncestors = []; for (let node = element; node; node = node.parentElement) window.qaReceiptAncestors.push({ node, tag: node.tagName, className: node.className }); window.qaReceiptNode = element; for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'toggle']) element.addEventListener(type, event => { window.qaReceiptDisclosure.push({ type, open: element.open, trusted: event.isTrusted, connected: element.isConnected, target: event.target.tagName }); if (type === 'mousedown') window.qaReceiptPressPoint = { x: event.clientX, y: event.clientY }; }); for (const type of ['pointerup', 'mouseup', 'click', 'focusin']) document.addEventListener(type, event => { if (window.qaReceiptDisclosure.length < 64) window.qaReceiptDisclosure.push({ global: true, type, target: event.target.tagName, className: event.target.className }); }, { capture: true }); });
  report.receiptDrawer = { before: await readDrawer.evaluate(element => ({ open: element.open, headers: [...element.querySelectorAll('.tool-card-title')].map(node => node.textContent) })) };
  if (!await readDrawer.evaluate(element => element.open)) await readDrawer.locator(':scope > summary').click();
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  report.receiptDrawer.after = await readDrawer.evaluate(element => ({ open: element.open, sameNode: element === window.qaReceiptNode, ancestors: window.qaReceiptAncestors.map(({ node, tag, className }) => ({ tag, className, connected: node.isConnected, containsCurrent: node.contains(element) })), pointTarget: window.qaReceiptPressPoint ? document.elementFromPoint(window.qaReceiptPressPoint.x, window.qaReceiptPressPoint.y)?.outerHTML.slice(0, 128) : undefined, bodies: [...element.querySelectorAll('.browser-tool-activity')].map(node => ({ tool: node.dataset.browserTool, caller: node.dataset.callerSessionId })) }));
  report.receiptDrawer.events = await page.evaluate(() => window.qaReceiptDisclosure);
  const screenshotCard = page.getByTestId(`session-chat-${codex.id}`).locator(`.browser-tool-activity[data-browser-tool="browser_screenshot"][data-caller-session-id="${codex.id}"]`).last();
  await until(async () => await screenshotCard.count() && (await screenshotCard.textContent()).includes('Completed'), 'authoritative completed browser screenshot Chat card');
  const pressed = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']; assert.deepEqual(report.receiptDrawer.events.filter(event => !event.global && pressed.includes(event.type)).map(event => event.type), pressed); assert.ok(report.receiptDrawer.events.filter(event => !event.global && pressed.includes(event.type)).every(event => event.trusted && event.connected)); assert.equal(report.receiptDrawer.after.sameNode, true);
  assert.match(await screenshotCard.textContent(), /Browser agent fixture/); assert.ok((await screenshotCard.textContent()).includes(baseUrl)); assert.ok((await screenshotCard.textContent()).includes(codex.id));
  const thumbnail = screenshotCard.getByRole('img', { name: 'Browser screenshot preview', exact: true });
  await thumbnail.scrollIntoViewIfNeeded();
  await until(() => thumbnail.evaluate(image => image.complete && image.naturalWidth > 0), 'decoded Chat screenshot thumbnail');
  const thumb = await thumbnail.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, src: image.getAttribute('src') }));
  assert.match(thumb.src, /^data:image\/jpeg;base64,/); assert.ok(Math.max(thumb.width, thumb.height) <= 240); assert.ok(Buffer.from(thumb.src.split(',')[1], 'base64').length <= 16 * 1024); await thumbnail.scrollIntoViewIfNeeded(); await shot('browser-read-chat-receipt.png');
  assert.equal(createHash('sha256').update(Buffer.from(thumb.src.split(',')[1], 'base64')).digest('hex'), reads[3].provenance.thumbnailSha256); assert.doesNotMatch(await screenshotCard.textContent(), /PROVIDER_FORGED_BROWSER_TITLE|provider-forged-caller/);
  check('Current Chat renders authoritative page metadata and exact main thumbnail despite forged provider metadata and JPEG trailing bytes');
  await readOff(); const revoked = await sendUi(codex, 'revoked', [{ tool: 'browser_list_tabs' }, { tool: 'browser_snapshot', target: 'last' }]); assert.equal(revoked[0].tabs.length, 0); assert.equal(revoked[1].isError, true);
  await readOn(); const reshared = await sendUi(codex, 'reshared', [{ tool: 'browser_list_tabs' }]); assert.notEqual(reshared[0].tabs[0].tabId, firstHandle);
  check('Off waits for runtime unregister; re-share creates a fresh opaque handle and old reads fail');
  const foreignProject = await request('project.add', { path: foreignWork, name: 'Foreign browser scope', operationId: randomUUID() }), foreign = await request('session.create', { projectId: foreignProject.id, cwd: foreignWork, provider: 'codex', mode: 'chat', title: 'Foreign browser caller', operationId: randomUUID() });
  const foreignReads = await sendBackground(foreign, 'foreign', [{ tool: 'browser_list_tabs' }, { tool: 'browser_snapshot', arguments: { tabId: reshared[0].tabs[0].tabId } }]); assert.equal(foreignReads[0].tabs.length, 0); assert.equal(foreignReads[1].isError, true); assert.equal((await state()).sharing.level, 'read');
  check('A foreign project/worktree caller cannot list or read the still-shared native tab');
  await request('plugin.setEnabled', { pluginId: 'browser-agent-reads-qa', enabled: true, operationId: randomUUID() }); await until(async () => (await request('provider.list')).some(value => value.id === 'browser-agent-read-echo' && value.chat), 'public ACP fixture capability');
  const acp = await request('session.create', { projectId: project.id, cwd: work, provider: 'browser-agent-read-echo', mode: 'chat', title: 'Browser agent ACP', operationId: randomUUID() });
  const acpReads = await sendBackground(acp, 'acp-read', [{ tool: 'browser_list_tabs' }, { tool: 'browser_snapshot', target: 'last' }, { tool: 'browser_console_messages', target: 'last', arguments: { level: 'debug' } }, { tool: 'browser_screenshot', target: 'last' }]); assert.equal(acpReads[0].tabs[0].tabId, reshared[0].tabs[0].tabId); assert.ok(acpReads.slice(1).every(value => !value.isError)); assert.deepEqual(acpReads[2].levels, ['debug']); assert.ok(acpReads[3].image); assert.ok(acpReads.slice(1).every(value => value.provenance.callerSessionId === acp.id));
  check('A public ACP plugin receives process-scoped composed MCP identity and reads the same explicitly shared worktree tab');
  privateImageHashes.add(acpReads[3].image.sha256);
  await browser({ type: 'navigate', tabId: source, url: `${baseUrl}/next#same` }); await loaded(`${baseUrl}/next#same`); assert.equal((await state()).sharing.level, 'read');
  const beforeHash = await state(); await browser({ type: 'navigate', tabId: source, url: `${baseUrl}/next#changed` }); await loaded(`${baseUrl}/next#changed`); const afterHash = await state(); assert.equal(afterHash.sharing.level, 'read'); assert.equal(afterHash.documentGeneration, beforeHash.documentGeneration); assert.ok(afterHash.sharing.navigationEpoch > beforeHash.sharing.navigationEpoch);
  await browser({ type: 'navigate', tabId: source, url: 'file:///not-an-owned-page' }); assert.equal((await state()).sharing.level, 'off'); await readOn(); await sendUi(codex, 'blocked-reshare', [{ tool: 'browser_list_tabs' }]);
  await browser({ type: 'navigate', tabId: source, url: `${otherUrl}/other` }); await loaded(`${otherUrl}/other`); assert.equal((await state()).sharing.level, 'off'); await browser({ type: 'navigate', tabId: source, url: `${baseUrl}/page` }); await loaded(`${baseUrl}/page`); assert.equal((await state()).sharing.level, 'off');
  const originRevoked = await sendUi(codex, 'origin-revoked', [{ tool: 'browser_list_tabs' }, { tool: 'browser_snapshot', target: 'last' }]); assert.equal(originRevoked[0].tabs.length, 0); assert.equal(originRevoked[1].isError, true);
  check('Same-origin and same-document navigation retain Read with fresh fences; blocked/cross-origin attempts revoke and return never restores sharing');
  await readOn();await sendUi(codex,'final-read-handle',[{tool:'browser_list_tabs'}]); await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1600, 1000); });
  for (const width of [720, 565, 400]) { await paneWidth(width); for (const theme of ['light', 'dark', 'custom']) { await setTheme(theme); const result = await checkControlConsistency(page, '.pane-tab-surface:not([hidden]) .wb-web-preview .wb-browser-toolbar', { checkStates: true, checkDisabledRows: true }); assertNoControlViolations(result, `B3 ${theme} ${width}px`); report.themes.push({ width, theme, result }); await shot(`sharing-${theme}-${width}.png`); } }
  await setTheme('light'); await readOff();
  for (let count = 0; count < 80; count++) { if (await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Agent access Read')) break; await page.keyboard.press('Tab'); }
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Agent access Read'); await page.keyboard.press('Enter'); await until(async () => (await state()).sharing.level === 'read', 'keyboard Read grant');
  await sendUi(codex, 'keyboard-read-handle', [{ tool: 'browser_list_tabs' }]);
  check('Sharing controls support keyboard activation and shared-token light/dark/custom layouts at wide, ~565px and ~400px panes');
  await browser({ type: 'navigate', tabId: source, url: `${baseUrl}/busy` }); await loaded(`${baseUrl}/busy`); await pause(2200);
  await sendUi(codex,'cancel-read',[{tool:'browser_snapshot',target:'last'}],false);await until(async()=>(await rows()).some(row=>row.event==='mcp.started'&&row.detail.id==='cancel-read'),'actual pending native read');await until(async()=>(await state()).sharing.reading,'main-confirmed pending native inspection',5000);
  const { leaseEpoch: renewedLease } = await request('session.claim', { sessionId: codex.id, clientId: 'threadterm-renderer' }); assert.equal(renewedLease, foregroundLease); const beforeStale = (await rows()).length;
  let staleOutcome = 'no-op'; try { await request('chat.cancel', { sessionId: codex.id, turnId: 'stale-test-turn', leaseEpoch: renewedLease }); } catch (error) { assert.match(String(error), /turn_not_active/); staleOutcome = 'rejected'; } await pause(150); assert.equal((await state()).sharing.reading, true); assert.equal((await rows()).slice(beforeStale).some(row => row.event === 'turn.cancel' || row.event === 'mcp.localCancel'), false); report.staleTurn = { outcome: staleOutcome, leaseUnchanged: true, pendingNativeReadPreserved: true };
  check('A stale-turn cancel preserves the current native read and provider turn');
  const stopStarted=Date.now();await page.getByTestId(`session-chat-${codex.id}`).getByRole('button',{name:'Stop',exact:true}).click();const cancelled=await turnReceipt('cancel-read',15_000);assert.equal(cancelled[0].isError,true);await until(async()=>!(await state()).sharing.reading,'cancelled main inspection drained',5000);report.cancellation={elapsedMs:Date.now()-stopStarted,nativePendingBeforeStop:true};
  check('User Stop cancels the actual composed MCP/native read without a later result delivery');
  assert.ok((await rows()).some(row => row.event === 'mcp.localCancel' && row.detail.notificationSent === false)); assert.ok((await rows()).some(row => row.event === 'turn.cancel' && row.detail.notifiedMcp === false));
  await sendUi(codex, 'deadline-read', [{ tool: 'browser_snapshot', target: 'last' }], false); const deadline = await turnReceipt('deadline-read', 20_000); assert.equal(deadline[0].isError, true); assert.match(deadline[0].error, /deadline|timed.out/i);
  check('A real stalled page inspection reaches its bounded deadline without replay or app focus');
  await until(async () => await page.getByTestId(`session-chat-${codex.id}`).locator('.v3-chat-message').filter({ hasText: 'BROWSER_QA_RESULT {"id":"deadline-read"' }).count() > 0 && await page.getByTestId(`session-chat-${codex.id}`).locator('.chat-compose-send.is-stop').count() === 0, 'projected deadline Chat turn');
  const deadlineDrawer = page.getByTestId(`session-chat-${codex.id}`).locator('.chat-tool-activity').last(); report.deadlineCards = await deadlineDrawer.locator('.chat-tool-entry').evaluateAll(nodes => nodes.map(node => ({ tool: node.querySelector('.tool-card-title')?.textContent, status: node.dataset.toolStatus, badge: node.querySelector('.tool-card-status')?.textContent }))); await until(() => deadlineDrawer.locator('.chat-tool-entry[data-tool-status="failed"]').count(), 'failed browser deadline Chat receipt');
  assert.equal((await page.getByTestId(`session-chat-${codex.id}`).textContent()).includes('BROWSER_QA_RESULT {"id":"cancel-read"'), false);
  await browser({ type: 'close', tabId: source }); const closed = await sendUi(codex, 'closed-read', [{ tool: 'browser_snapshot', target: 'last' }]); assert.equal(closed[0].isError, true);
  check('Closing the native view revokes its public handle and prevents subsequent native reads');
  assert.deepEqual(await page.evaluate(() => window.qaBrowserPrivateFanout), []);assert.deepEqual(await page.evaluate(() => window.qaBrowserRawPageLeaks), []);assert.deepEqual(await page.evaluate(() => window.qaBrowserPrivateImages), []); await assertPrivateDataAbsentFromDatabase(); check('Private traffic/raw page markers/full image payloads stay absent from renderer events and persisted outbox/history; forged metadata is omitted');
  const catalogs = (await rows()).filter(row => row.event === 'mcp.catalog'); assert.ok(catalogs.length >= 3); assert.equal(catalogs.filter(row => row.detail.names.includes('browser_snapshot')).length, catalogs.length); report.mcpCatalogs = catalogs.map(row => ({ pid: row.pid, names: row.detail.names }));
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.errors.push(error?.stack || String(error)); if (page) { report.activityStatuses = await page.evaluate(() => [...document.querySelectorAll('.chat-tool-entry')].map(node => ({ tool: node.querySelector('.tool-card-title')?.textContent, status: node.dataset.toolStatus, badge: node.querySelector('.tool-card-status')?.textContent }))).catch(() => []); await within(() => shot('failure.png'), 5000); } process.exitCode = 1; }
finally {
  if (app && page) await within(() => writeBrowserViewDiagnostics(app, page, out), 5000);
  const cleanup = await closeBrowserViewFixture({ app, page, runtime: runtimeProcess, shutdownRuntime: true }); report.errors.push(...cleanup);
  await Promise.all(servers.map(server => new Promise(done => server.close(done))));
  const target = resolve(scratch); assert.equal(dirname(target).toLowerCase(), scratchBase.toLowerCase()); await rm(target, { recursive: true, force: true, maxRetries: 5 }).catch(error => { report.errors.push(String(error)); });
  report.scratchRemoved = !existsSync(target); if (!report.scratchRemoved) report.errors.push('Disposable fixture scratch cleanup did not finish.');
  report.passed = report.passed && report.errors.length === 0; report.completedAt = new Date().toISOString(); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(report.passed ? 'BROWSER AGENT TOOLS VISUAL QA PASSED' : `BROWSER AGENT TOOLS VISUAL QA FAILED\n${report.errors.join('\n')}`); process.exitCode = report.passed ? 0 : 1;
}
