// Actual Electron/native page + real runtime/composed MCP; scripted Codex peer, no live account/model calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(import.meta.dirname, '..'), exe = resolve(process.argv[2] || 'node_modules/electron/dist/electron.exe');
const dev = process.argv.includes('--dev'), out = resolve(process.env.THREADTERM_QA_BROWSER_CONTROL_OUT || 'qa/results/browser-control-packaged');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-browser-control-'));
const bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins'), fixture = join(plugins, 'browser-agent-reads-qa'), work = join(scratch, 'project'), events = join(scratch, 'events.jsonl');
const provider = process.argv.includes('--codex-fixture') ? 'codex' : 'browser-agent-read-echo';
const git = process.env.THREADTERM_TEST_GIT || 'git';
const report = { passed: false, executable: exe, packaged: !dev, provider, checks: [], limitations: ['Public scripted ACP peer (or optional debug-only Codex peer) through composed MCP, not a live model/account.'], scratch };
let app, page, releaseLock;
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(`<!doctype html><title>Control fixture</title><style>body{padding:24px;font:18px sans-serif}button,input,select{font:inherit;margin:12px;padding:8px}#hover{display:block;width:200px;height:50px}</style><h1>Control fixture</h1><button id="click" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Click target</button><label>Name<input id="name" onkeydown="if(event.key==='Enter')document.body.dataset.enter='yes'"></label><label>Choice<select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label><button id="hover" onmouseover="document.body.dataset.hover='yes'">Hover target</button><p>${req.url}</p>`); });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const until = async (probe, label, ms = 30000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const value = await probe(); if (value) return value; } catch (error) { last = error; } await new Promise(done => setTimeout(done, 60)); } throw Error(`Timed out: ${label} ${last || ''}`); };
const request = (method, params = {}) => page.evaluate(([method, params]) => window.threadterm.request(method, params), [method, params]);
const browser = command => page.evaluate(command => window.threadterm.browserCommand(command), command);
const preview = () => page.locator('.wb-web-preview:visible').first();
const sourceId = () => preview().getAttribute('data-web-tab-id');
const state = async () => browser({ type: 'state', tabId: await sourceId() });
const rows = async () => (await readFile(events, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const data = result => { const text = result?.content?.find(block => block.type === 'text')?.text || ''; const start = text.indexOf('{'); return start >= 0 ? JSON.parse(text.slice(start)) : {}; };
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };

try {
  await mkdir(out, { recursive: true }); for (const dir of [bin, work, plugins, join(scratch, 'home')]) await mkdir(dir, { recursive: true });
  await cp(join(root, 'qa/fixtures/browser-agent-reads'), fixture, { recursive: true });
  const manifestPath = join(fixture, 'threadterm-plugin.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await cp(process.execPath, join(fixture, 'node.exe'));
  manifest.contributes.agents[0].command = '{pluginDir}/node.exe';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const mcpPath = join(fixture, 'mcp.cjs'), mcpSource = await readFile(mcpPath, 'utf8');
  assert.ok(mcpSource.includes('const value = data(result); if (value.tabs'));
  await writeFile(mcpPath, mcpSource.replace('const value = data(result); if (value.tabs', "log('raw.result', { id: control.id, tool: step.tool, result }); const value = data(result); if (value.tabs"));
  await writeFile(events, ''); await writeFile(join(bin, 'codex.cmd'), `@"${process.execPath}" "${join(fixture, 'codex.cjs')}" %*\r\n`);
  for (const args of [['init', '-q'], ['config', 'user.name', 'QA'], ['config', 'user.email', 'qa@example.test']]) execFileSync(git, args, { cwd: work, windowsHide: true });
  await writeFile(join(work, 'README.md'), 'Browser control QA\n'); execFileSync(git, ['add', '.'], { cwd: work, windowsHide: true }); execFileSync(git, ['commit', '-qm', 'init'], { cwd: work, windowsHide: true });
  const excluded = /^(path|home|userprofile|appdata|localappdata|codex_home|electron_run_as_node)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !excluded.test(key) && !key.toLowerCase().startsWith('threadterm_') && !/(API_KEY|AUTH_TOKEN|SECRET|OPENAI|ANTHROPIC)/i.test(key)));
  Object.assign(env, { PATH: [bin, dirname(process.execPath), dirname(git), join(process.env.SystemRoot, 'System32')].join(';'), HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'), CODEX_HOME: join(scratch, 'home/.codex'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-browser-control-${randomUUID()}`, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_QA_PROVIDER_BIN: bin, THREADTERM_QA_BROWSER_EVENTS: events, THREADTERM_QA_BROWSER_CWD: work, THREADTERM_QA_BROWSER_URL: baseUrl });
  if (dev) env.THREADTERM_V3_RUNTIME = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({ executablePath: exe, args: dev ? [root] : [], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), !dev);
  await page.waitForFunction(() => Boolean(window.threadterm?.browserCommand)); await page.locator('#boot-splash').waitFor({ state: 'detached' });
  const snap = await request('runtime.snapshot'); await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, sound: false } }, expectedRevision: snap.settings.revision, operationId: randomUUID() });
  if (provider !== 'codex') await request('plugin.setEnabled', { pluginId: 'browser-agent-reads-qa', enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(value => value.id === provider && value.chat), 'scripted provider peer discovered');
  const project = await request('project.add', { path: work, name: 'Browser control QA', operationId: randomUUID() });
  const session = await request('session.create', { projectId: project.id, cwd: work, provider, mode: 'chat', title: 'Browser control QA', operationId: randomUUID() });
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId: id }), session.id);
  const scope = page.getByTestId(`session-chat-${session.id}`); await scope.locator('textarea').first().waitFor();
  async function send(id, steps, chat = scope) {
    await until(async () => await chat.locator('.chat-compose-send.is-stop').count() === 0, 'previous turn settled');
    await chat.locator('textarea').first().fill(`qa-browser ${JSON.stringify({ id, steps })}`);
    const button = chat.locator('.chat-compose-send[type=submit]'); await until(() => button.isEnabled(), 'Send enabled'); await button.click();
    await until(async () => (await rows()).some(row => row.event === 'turn.result' && row.detail.id === id), id);
    await until(async () => await chat.locator('.chat-compose-send.is-stop').count() === 0, `${id} completed`);
    return (await rows()).filter(row => row.event === 'raw.result' && row.detail.id === id).map(row => row.detail.result);
  }
  let results = await send('open', [{ tool: 'preview_present', path: 'page' }]); assert.notEqual(results[0].isError, true);
  await preview().waitFor(); await until(async () => { const value = await state(); return value.url === `${baseUrl}/page` && !value.loading && value.navigation === 'load_observed'; }, 'native page loaded');
  assert.equal((await state()).sharing.controlAvailable, true);
  await preview().getByRole('button', { name: 'Agent access Control', exact: true }).click();
  await page.getByRole('button', { name: 'Allow Control', exact: true }).click();
  await until(async () => (await state()).sharing.level === 'control', 'Control grant'); check('Production Control capability and explicit UI grant');
  if (process.argv.includes('--diagnostics')) await app.evaluate(({ webContents }, baseUrl) => {
    const contents = webContents.getAllWebContents().find(value => value.getURL().startsWith(baseUrl));
    globalThis.browserControlTrace = [];
    const original = contents.debugger.sendCommand.bind(contents.debugger);
    contents.debugger.sendCommand = async (method, params) => { const result = await original(method, params); if (['DOM.getBoxModel','DOM.getNodeForLocation','Runtime.callFunctionOn','DOM.describeNode'].includes(method)) globalThis.browserControlTrace.push({ method, params, result }); return result; };
  }, baseUrl);
  results = await send('snapshot', [{ tool: 'browser_list_tabs' }, { tool: 'browser_snapshot', target: 'last' }]);
  const outline = data(results[1]).outline; assert.equal(typeof outline, 'string');
  const ref = name => { const role = name === 'Name' ? 'textbox' : name === 'Choice' ? 'combobox' : 'button'; const line = outline.split('\n').find(line => line.trimStart().startsWith(`${role} ${JSON.stringify(name)} [`)); const match = /\[(ref-[^\]]+)\]/.exec(line || ''); assert.ok(match, `Missing ${role} reference for ${name}: ${outline}`); return match[1]; };
  async function action(id, tool, args) { const result = (await send(id, [{ tool, target: 'last', arguments: args }]))[0]; assert.notEqual(result.isError, true, JSON.stringify(result)); const receipt = data(result); assert.equal(receipt.outcome, 'completed', JSON.stringify(result)); return receipt; }
  const observe = () => app.evaluate(({ webContents }, baseUrl) => { const contents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(baseUrl)); if (!contents) throw Error('Native page missing'); return contents.executeJavaScript(`({clicks:document.body.dataset.clicks||'0',name:document.querySelector('#name').value,choice:document.querySelector('#choice').value,enter:document.body.dataset.enter,hover:document.body.dataset.hover})`); }, baseUrl);
  await action('click', 'browser_click', { ref: ref('Click target') }); assert.equal((await observe()).clicks, '1'); check('Composed MCP browser_click changed real page');
  await action('type', 'browser_type', { ref: ref('Name'), text: 'Portable control works' }); assert.equal((await observe()).name, 'Portable control works'); check('Composed MCP browser_type changed real input');
  await action('select', 'browser_select_option', { ref: ref('Choice'), values: ['b'] }); assert.equal((await observe()).choice, 'b'); check('Composed MCP browser_select_option changed real select');
  await action('key', 'browser_press_key', { ref: ref('Name'), key: 'Enter' }); assert.equal((await observe()).enter, 'yes'); check('Composed MCP browser_press_key delivered real page key');
  await action('hover', 'browser_hover', { ref: ref('Hover target') }); assert.equal((await observe()).hover, 'yes'); check('Composed MCP browser_hover delivered real mouse event');
  await preview().getByRole('button', { name: 'Agent access Off', exact: true }).click(); await until(async () => (await state()).sharing.level === 'off', 'grant revoked');
  results = await send('denied', [{ tool: 'browser_click', target: 'last', arguments: { ref: ref('Click target') } }]); assert.equal(results[0].isError, true); assert.equal((await observe()).clicks, '1'); check('Revoked grant causes zero additional native mutation');
  await preview().getByRole('button', { name: 'Agent access Control', exact: true }).click(); await page.getByRole('button', { name: 'Allow Control', exact: true }).click(); await until(async () => (await state()).sharing.level === 'control', 'new Control grant');
  await send('relist', [{ tool: 'browser_list_tabs' }]);
  const navigated = await action('navigate', 'browser_navigate', { url: `${baseUrl}/next` }); assert.equal(navigated.navigation.admitted, true); assert.equal(navigated.navigation.sharingRevoked, true);
  await until(async () => { const value = await state(); return value.url === `${baseUrl}/next` && value.sharing.level === 'off' && value.sharing.status === 'idle'; }, 'navigation and Control revocation'); check('Composed MCP browser_navigate admitted and revoked sharing');
  if (process.argv.includes('--conversation-scope')) {
    const originalTab = await sourceId();
    const access = mode => preview().getByRole('button', { name: `Agent access ${mode}`, exact: true });
    await until(() => access('Read').isEnabled(), 'Read available after navigation');
    await access('Read').click();
    await until(async () => (await state()).sharing.worktreeRead, 'explicit Read');
    await access('Control').click();
    await page.getByRole('button', { name: 'Allow Control', exact: true }).click();
    await until(async () => (await state()).sharing.controlSessionIds?.includes(session.id), 'conversation A owns Control');
    const [listedA] = await send('scope-a', [{ tool: 'browser_list_tabs' }]);
    const [controlTab] = data(listedA).tabs;
    assert.equal(controlTab.shareLevel, 'control');
    const other = await request('session.create', { projectId: project.id, cwd: work, provider, mode: 'chat', title: 'Browser control QA B', operationId: randomUUID() });
    const switchTo = id => app.evaluate(({ BrowserWindow }, sessionId) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId }), id);
    await switchTo(other.id);
    const otherChat = page.getByTestId(`session-chat-${other.id}`);
    const [listedB, readable, denied] = await send('scope-b', [
      { tool: 'browser_list_tabs' },
      { tool: 'browser_snapshot', target: 'last' },
      { tool: 'browser_snapshot', arguments: { tabId: controlTab.tabId } },
    ], otherChat);
    const readTabs = data(listedB).tabs;
    assert.equal(readTabs.length, 1);
    const [readTab] = readTabs;
    assert.equal(readTab.shareLevel, 'read');
    assert.notEqual(readTab.tabId, controlTab.tabId);
    assert.equal(typeof data(readable).outline, 'string');
    assert.equal(denied.isError, true);
    const [openedB] = await send('scope-b-open', [{ tool: 'preview_present', path: 'next' }], otherChat);
    assert.notEqual(openedB.isError, true);
    await until(async () => await sourceId() !== originalTab && (await state()).navigation === 'load_observed', 'B opens its own tab');
    assert.equal((await state()).sharing.level, 'off');
    await switchTo(session.id);
    const [returned] = await send('scope-a-return', [{ tool: 'browser_list_tabs' }]);
    assert.deepEqual(data(returned).tabs, [controlTab]);
    const original = await browser({ type: 'state', tabId: originalTab });
    assert.equal(Boolean(original.unloaded), false);
    assert.deepEqual(original.sharing.controlSessionIds, [session.id]);
    check('Control survives A/B/A, while B can only discover the explicit Read grant');
  }
  await page.screenshot({ path: join(out, 'success.png') }); report.passed = true;
} catch (error) {
  report.error = error.stack || String(error); process.exitCode = 1;
  if (app) report.nativeDiagnostics = await app.evaluate(({ webContents }, baseUrl) => {
    const contents = webContents.getAllWebContents().find(value => value.getURL().startsWith(baseUrl));
    return Promise.resolve(contents?.executeJavaScript(`({width:innerWidth,height:innerHeight,rects:Object.fromEntries(['click','name','choice','hover'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [id,{x:r.x,y:r.y,width:r.width,height:r.height}]}))})`)).then(geometry => ({geometry,trace:globalThis.browserControlTrace}));
  }, baseUrl).catch(() => undefined);
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
}
finally {
  if (page) await request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await releaseLock?.(); await new Promise(done => server.close(done)); await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
