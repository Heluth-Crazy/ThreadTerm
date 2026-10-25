// Real desktop QA for the local-history dialog.  It runs the production Electron
// sources against an isolated runtime and a deliberately small ACP history agent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/history-echo-acp');
const out = join(root, 'qa/results/local-history');
const scratch = await mkdtemp(join(tmpdir(), 'tt-local-history-'));
const report = { passed: false, scratch, checks: [], screenshots: [], errors: [], limitations: ['The ACP provider is an isolated deterministic fixture. This verifies ThreadTerm’s real Electron renderer, bridge, and Rust runtime, not a third-party provider CLI.'] };
let app; let page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; for (;;) { try { const value = await probe(); if (value) return value; } catch {} if (Date.now() >= end) throw Error(`Timed out: ${label}`); await delay(120); } }
async function shot(name) { await delay(150); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function buildApp(appDir) {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-local-history-qa', version: '0.1.0', main: 'main.cjs' }));
}
function history(work) { return { sessions: [
  { sessionId: 'before-threadterm', cwd: work, title: 'Before ThreadTerm', updatedAt: '2026-10-07T10:00:00.000Z', updates: [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Old question' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Old answer' } },
  ] },
  { sessionId: 'other-native', cwd: work, title: 'Other native session', updatedAt: '2026-10-06T10:00:00.000Z', updates: [] },
] }; }
function fixtureAgent() { return `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'; import { createInterface } from 'node:readline';
const file=process.env.THREADTERM_QA_HISTORY_FILE, events=process.env.THREADTERM_QA_HISTORY_EVENTS;
const records=()=>{try{return JSON.parse(readFileSync(file,'utf8')).sessions||[]}catch{return[]}};
const log=(method,params)=>{if(events)appendFileSync(events,JSON.stringify({method,params})+'\\n')};
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n'), ok=(id,result)=>send({jsonrpc:'2.0',id,result});
if(process.argv.includes('--version')) console.log('history-echo-local-history-qa 1.0.0');
else if(process.argv.includes('login')) console.log('History Echo needs no sign-in.');
else if(process.argv.includes('--acp')) createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{let r;try{r=JSON.parse(line)}catch{return} const {id,method,params={}}=r; log(method,params); if(method==='initialize')return ok(id,{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:{},load:{},resume:{}}}}); if(method==='initialized')return; if(method==='session/list')return ok(id,{sessions:records().map(({sessionId,cwd,title,updatedAt})=>({sessionId,cwd,title,updatedAt}))}); if(method==='session/load'){const s=records().find(x=>x.sessionId===params.sessionId);if(!s)return send({jsonrpc:'2.0',id,error:{code:-32004,message:'missing history'}});for(const u of s.updates||[])send({jsonrpc:'2.0',method:'session/update',params:{sessionId:s.sessionId,update:{sessionUpdate:u.sessionUpdate,...u}}});return ok(id,{sessionId:s.sessionId})} if(method==='session/resume')return ok(id,{sessionId:params.sessionId}); if(method==='session/new')return ok(id,{sessionId:'new'}); if(method==='session/cancel')return ok(id,{}); if(id!==undefined)send({jsonrpc:'2.0',id,error:{code:-32601,message:'Unsupported '+method}});});
`;
}
function inside(outer, inner) { return Boolean(outer && inner && inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height); }
async function setSettings(language, theme) {
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language, theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(({ language, theme }) => document.documentElement.lang === language && document.documentElement.dataset.theme === theme, { language, theme });
}
async function openOptions() { await page.getByRole('button', { name: 'Terminal page options' }).click(); await page.getByRole('menu', { name: 'Actions' }).waitFor(); }
async function localDialog() { await page.getByRole('button', { name: 'Local history' }).click(); await page.locator('.local-history-dialog').waitFor(); return page.locator('.local-history-dialog'); }
async function chooseSelect(scope, label, option) { await scope.getByRole('combobox', { name: label }).click(); await page.getByRole('option', { name: option, exact: true }).click(); }

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime before running this QA`);
  assert.ok(existsSync(join(fixture, 'threadterm-plugin.json')), 'missing history fixture');
  await mkdir(out, { recursive: true });
  const appDir = join(scratch, 'app'); const plugins = join(scratch, 'plugins'); const work = join(scratch, 'pre-existing-project'); const historyFile = join(scratch, 'native-history.json'); const eventsFile = join(scratch, 'agent-events.jsonl');
  await buildApp(appDir); await mkdir(work, { recursive: true }); await writeFile(join(work, 'README.md'), '# pre-existing history\n'); await writeFile(historyFile, `${JSON.stringify(history(work), null, 2)}\n`);
  cpSync(fixture, join(plugins, 'history-echo-acp'), { recursive: true }); await writeFile(join(plugins, 'history-echo-acp', 'agent.mjs'), fixtureAgent());
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const providerHome = join(scratch, 'provider-home'); await mkdir(providerHome, { recursive: true });
  Object.assign(env, { PATH: [dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), HOME: providerHome, USERPROFILE: providerHome, CODEX_HOME: join(providerHome, '.codex'), CLAUDE_CONFIG_DIR: join(providerHome, '.claude'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-local-history-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_QA_HISTORY_FILE: historyFile, THREADTERM_QA_HISTORY_EVENTS: eventsFile });
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`)); page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor(); await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 15_000 }); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await setSettings('en', 'light'); await page.locator('#boot-splash').waitFor({ state: 'hidden' });
  await until(async () => (await request('plugin.list')).plugins.some(plugin => plugin.id === 'history-echo-acp'), 'fixture discovery');
  await request('plugin.setEnabled', { pluginId: 'history-echo-acp', enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(provider => provider.id === 'history-echo' && provider.chat), 'fixture capability');
  const project = await request('project.add', { path: work, name: 'Pre-existing project', operationId: randomUUID() });
  await page.locator('.nav-item').filter({ hasText: /^All terminals$/ }).click();

  await openOptions(); const menu = page.getByRole('menu', { name: 'Actions' }); const items = menu.getByRole('menuitem'); assert.equal(await items.count(), 8, 'options contain six scopes, manual order, and native history');
  const menuBox = await menu.boundingBox(); const view = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })); assert.ok(menuBox && menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= view.width && menuBox.y + menuBox.height <= view.height, 'page options are fully inside the viewport');
  for (const item of await items.all()) { assert.ok(await item.isVisible(), `options item ${await item.innerText()} visible`); }
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden', timeout: 1_000 });
  await openOptions(); await page.mouse.click(8, 300); await until(async () => (await page.getByRole('menu', { name: 'Actions' }).count()) === 0, 'outside dismisses options');
  for (const label of ['All sessions', 'Active', 'Recent', 'Followed', 'Bookmarks', 'Archived']) { await openOptions(); await menu.getByRole('menuitem', { name: new RegExp(label) }).click(); }
  await openOptions(); await menu.getByRole('menuitem', { name: 'Manual order' }).click(); await openOptions(); await menu.getByRole('menuitem', { name: 'Stop manual ordering' }).click(); check('terminal page options are complete, viewport-clamped, keyboard/outside-dismissible, and every scope action is clickable');

  const dialog = await localDialog(); const native = dialog.getByRole('button', { name: 'Native sessions' }); const saved = dialog.getByRole('button', { name: 'ThreadTerm records' }); assert.equal(await native.getAttribute('aria-pressed'), 'true'); await page.locator('.history-rail-native .history-native-list article').first().waitFor();
  const nativeRail = dialog.locator('.history-rail-native'); await nativeRail.getByRole('button', { name: 'Reload native sessions' }).click(); await nativeRail.getByRole('button', { name: 'Read', exact: true }).first().waitFor();
  await nativeRail.locator('.history-native-list article').filter({ hasText: 'Before ThreadTerm' }).getByRole('button', { name: 'Read', exact: true }).click(); await nativeRail.locator('.history-detail').waitFor(); await until(async () => /Old question[\s\S]*Old answer/.test(await nativeRail.locator('.history-detail').innerText()), 'native transcript load');
  await chooseSelect(nativeRail.locator('.history-detail'), 'Mode', 'Structured Chat'); const beforeImportEvents = existsSync(eventsFile) ? await readFile(eventsFile, 'utf8') : '';
  await nativeRail.getByRole('button', { name: 'Import card', exact: true }).click();
  await until(async () => (await request('runtime.snapshot')).sessions.filter(session => session.readOnly && session.nativeId === 'before-threadterm').length === 1, 'exactly one read-only imported record');
  const importEvents = (await readFile(eventsFile, 'utf8')).slice(beforeImportEvents.length); assert.doesNotMatch(importEvents, /session\/(prompt|new|resume)/, 'import must not start an interactive session or prompt an agent');
  const imported = (await request('runtime.snapshot')).sessions.find(session => session.readOnly && session.nativeId === 'before-threadterm'); assert.equal(imported.projectId, project.id); check('pre-existing native history is discovered, readable, and imported exactly once as a read-only project-owned card without an agent prompt');

  await nativeRail.getByRole('button', { name: 'All records', exact: true }).click(); await nativeRail.locator('.history-native-list').waitFor();
  const changed = history(work); changed.sessions.push({ sessionId: 'added-after-start', cwd: work, title: 'Added after ThreadTerm start', updatedAt: '2026-10-08T10:00:00.000Z', updates: [] }); await writeFile(historyFile, `${JSON.stringify(changed, null, 2)}\n`);
  await nativeRail.getByRole('button', { name: 'Reload native sessions' }).click(); await nativeRail.locator('.history-native-list article').filter({ hasText: 'Added after ThreadTerm start' }).waitFor(); check('Reload native sessions finds a record added after ThreadTerm started');

  await nativeRail.locator('.history-native-list article').filter({ hasText: 'Before ThreadTerm' }).getByRole('button', { name: 'Read', exact: true }).click();
  await nativeRail.locator('.history-detail').getByRole('button', { name: 'Resume explicitly', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Resume native session' }); await confirmation.waitFor();
  assert.match(await confirmation.innerText(), /Resume this provider session explicitly/);
  const resumeEventOffset = (await readFile(eventsFile, 'utf8')).length;
  await confirmation.getByRole('button', { name: 'Resume', exact: true }).click();
  await until(async () => { const session = (await request('runtime.snapshot')).sessions.find(row => row.id === imported.id); return session && session.readOnly !== true && session.nativeId === 'before-threadterm'; }, 'confirmed resume preserves native identity');
  await until(async () => (await readFile(eventsFile, 'utf8')).slice(resumeEventOffset).split(/\r?\n/).filter(Boolean).map(JSON.parse).some(event => event.method === 'session/load' && event.params?.sessionId === 'before-threadterm'), 'resume dispatch loads the same native id');
  const resumedEvents = (await readFile(eventsFile, 'utf8')).slice(resumeEventOffset).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.ok(resumedEvents.filter(event => ['session/load', 'session/resume'].includes(event.method)).every(event => event.params?.sessionId === 'before-threadterm'), 'every resume/load uses the original native id');
  assert.equal(resumedEvents.some(event => ['session/new', 'session/prompt'].includes(event.method)), false, 'resume never creates a new session or submits a prompt');
  assert.doesNotMatch(await readFile(eventsFile, 'utf8'), /session\/prompt/, 'resume must not prompt before user action');
  check('eligible resume requires confirmation, reloads the same ACP native id, and preserves identity without a prompt');

  await page.locator('.local-history-dialog').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.locator('.nav-item').filter({ hasText: /^All terminals$/ }).click(); await page.locator('.terminals-page').waitFor();
  assert.equal(await page.locator('.local-history-dialog').count(), 0, 'returning from a resumed session must not reopen history');
  const savedDialog = await localDialog(); await saved.click(); const filters = savedDialog.locator('.history-saved-filters'); await filters.waitFor(); const labels = filters.locator('label'); assert.equal(await labels.count(), 5); for (const label of await labels.all()) { const box = await label.boundingBox(); const text = await label.innerText(); assert.ok(box && box.width > 50 && box.height > 30 && text.trim(), `saved filter labelled and usable: ${text}`); }
  await savedDialog.locator('.history-native-list article').filter({ hasText: imported.title }).locator('.history-row-main').click(); await until(async () => (await page.locator('.local-history-dialog').count()) === 0, 'saved-record navigation closes local history'); await page.locator('.t-inspect').filter({ hasText: imported.title }).waitFor(); check('saved-record navigation closes the dialog and opens the selected session summary');
  const matrixDialog = await localDialog(); await matrixDialog.getByRole('button', { name: 'ThreadTerm records' }).click();
  for (const [language, theme, width] of [['en', 'light', 1440], ['en', 'dark', 1280], ['zh-CN', 'light', 1920], ['zh-CN', 'dark', 420], ['zh-CN', 'light', 420], ['en', 'dark', 420]]) {
    await app.evaluate(({ BrowserWindow }, w) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(300, 300); win.setContentSize(w, 900); }, width);
    await page.waitForFunction(w => window.innerWidth === w, width); await setSettings(language, theme);
    const sourceButtons = page.locator('.local-history-dialog .history-source-switch button'); await sourceButtons.nth(0).click();
    await until(async () => (await page.locator('.local-history-dialog .history-native-list article').count()) === 3, 'matrix native scan complete');
    await shot(`native-${language}-${theme}-${width}.png`); await sourceButtons.nth(1).click(); await filters.waitFor();
    const dialogBox = await page.locator('.local-history-dialog').boundingBox(); assert.ok(dialogBox && dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= width, `dialog fits ${width}px ${language} ${theme}`);
    for (const select of await filters.locator('.tt-select').all()) assert.ok(inside(dialogBox, await select.boundingBox()), 'saved select fits dialog');
    const savedRow = page.locator('.local-history-dialog .session-history-rail article').first();
    const [checkbox, title] = await Promise.all([savedRow.locator('input[type="checkbox"]').boundingBox(), savedRow.locator('.history-row-main').boundingBox()]);
    assert.ok(checkbox && title && checkbox.x < title.x && Math.abs(checkbox.y - title.y) < 10, 'saved checkbox aligns beside its title');
    await shot(`saved-${language}-${theme}-${width}.png`);
    await page.locator('.local-history-dialog .sheet-head .icon-btn').click();
    await delay(200);
    const pageOptions = page.getByRole('button', { name: language === 'en' ? 'Terminal page options' : '终端页选项' });
    const anchorBox = await pageOptions.boundingBox(); assert.ok(inside({ x: 0, y: 0, width, height: 900 }, anchorBox), 'page-options anchor is visible');
    // A real pointer press avoids Playwright scrolling the forced-small main pane
    // after the menu has opened (the application normally has a 960px minimum).
    await page.mouse.click(anchorBox.x + anchorBox.width / 2, anchorBox.y + anchorBox.height / 2);
    const options = page.locator('.app-context-menu'); await options.waitFor(); const bounds = await options.boundingBox();
    assert.ok(inside({ x: 0, y: 0, width, height: 900 }, bounds), 'options fit current viewport');
    await options.getByRole('menuitem').last().waitFor();
    await page.screenshot({ path: join(out, `menu-${language}-${theme}-${width}.png`), animations: 'disabled' }); report.screenshots.push(`menu-${language}-${theme}-${width}.png`);
    assert.equal(await options.count(), 1, 'options remain open during screenshot'); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: language === 'en' ? 'Local history' : '本机历史', exact: true }).click(); await page.locator('.local-history-dialog').waitFor();
  }
  check('saved-record labels remain visible in English/Chinese light/dark wide and 420px views');
  assert.deepEqual(report.errors, [], report.errors.join('\n')); report.passed = true;
} catch (error) { report.errors.push(error instanceof Error ? error.stack || error.message : String(error)); if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); }
finally { if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {}); if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); } report.completedAt = new Date().toISOString(); await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(report.passed ? 'LOCAL HISTORY QA PASSED' : `LOCAL HISTORY QA FAILED\\n${report.errors.join('\\n')}`); process.exitCode = report.passed ? 0 : 1; }
