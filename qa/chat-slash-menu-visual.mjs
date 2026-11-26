// The Chat composer's "/" menu (owner 2026-11-26: take T3 Code's command menu as the reference). The real desktop app,
// the debug runtime and the Prompt Queue Echo ACP fixture, which lists /compact and /review-pr as its own commands.
// Checks the grouping, the ranking ("/rev" finds code-review), the keyboard (wrap, Tab, a new query at its best
// match), Escape keeping the text, and one 32px line per row. Screenshots go to qa/results/chat-slash-menu/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(import.meta.dirname, '..');
const base = resolve(process.env.TEMP ?? (() => { throw new Error('TEMP must point at a scratch directory'); })());
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const out = join(root, 'qa/results/chat-slash-menu');
const scratch = await mkdtemp(join(base, 'tt-chat-slash-'));
const bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins'), work = join(scratch, 'work');
const data = join(scratch, 'data'), profile = join(scratch, 'profile'), pipe = `\\\\.\\pipe\\tt-chat-slash-${randomUUID()}`;
const report = { passed: false, checks: [], errors: [], screenshots: [], measurements: {} };
let app, page, islandPage, releaseLock, qaApp;

const delay = ms => new Promise(done => setTimeout(done, ms));
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const settle = () => delay(250);
async function until(probe, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* the runtime is still catching up */ }
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await delay(125);
  }
}
const shot = async (target, name) => { await delay(200); await target.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); };
const islandDetails = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed())
  .map(window => ({ id: window.id, url: window.webContents.getURL(), visible: window.isVisible() })));
const findWindow = pattern => islandDetails().then(rows => rows.find(row => row.url.includes(pattern)));
const emitWindowEvent = name => app.evaluate(({ app: electronApp }, event) => electronApp.emit(event, {}, {}), name);
const showMainWindow = () => app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(row => !row.webContents.getURL().includes('island.html')); window?.show(); return window?.id; });
const hideMainWindow = () => app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(row => !row.webContents.getURL().includes('island.html')); window?.hide(); return window?.id; });
const settings = async patch => {
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
};
const islandCalls = () => app.evaluate(() => globalThis.__qaIsland.ignore.filter(call => call.island));
const navigations = () => app.evaluate(() => globalThis.__qaIsland.navigations);
const NOTIFICATIONS = { native: false, attention: false, completed: false, sound: false };

/** GWL_EXSTYLE via user32: WS_EX_TOOLWINDOW (0x80) keeps the island out of the taskbar, WS_EX_NOACTIVATE (0x08000000) out of focus. */
function nativeExStyle(handle) {
  const script = `Add-Type -Namespace Qa -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);'; [Qa.Native]::GetWindowLong([IntPtr]${handle}, -20)`;
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 }).trim());
}

/** Git is not needed by the island, but the runtime inspects the session's directory: keep a Git on the QA PATH. */
function gitDirectory() {
  const explicit = process.env.THREADTERM_TEST_GIT;
  if (explicit && existsSync(explicit)) return dirname(explicit);
  for (const directory of (process.env.PATH ?? '').split(';')) if (directory && existsSync(join(directory, 'git.exe'))) return directory;
  return join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd');
}

function environment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'temp', 'tmp', 'home', 'userprofile', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_runtime_bin'].includes(key.toLowerCase())));
  const git = gitDirectory();
  return Object.assign(env, {
    TEMP: base, TMP: base, PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), git].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: pipe,
    THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_QA_PROVIDER_BIN: bin,
    THREADTERM_ECHO_STORE_DIR: join(scratch, 'echo-store'),
  });
}

try {
  assert.ok(existsSync(runtime), `missing QA runtime: ${runtime}`);
  assert.ok(existsSync(join(root, 'qa/fixtures/prompt-queue-echo-acp/threadterm-plugin.json')), 'missing the Prompt Queue Echo fixture');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(plugins, { recursive: true }), mkdir(work, { recursive: true })]);
  cpSync(join(root, 'qa/fixtures/prompt-queue-echo-acp'), join(plugins, 'prompt-queue-echo-acp'), { recursive: true });
  const git = process.env.THREADTERM_TEST_GIT && existsSync(process.env.THREADTERM_TEST_GIT) ? process.env.THREADTERM_TEST_GIT : join(gitDirectory(), 'git.exe');
  try { execFileSync(git, ['init', '-q', '-b', 'main', work], { timeout: 60_000 }); } catch { /* a plain directory works too */ }

  qaApp = await buildQaApp({ root, outDir: join(scratch, 'app') });
  releaseLock = await acquireElectronQaLock({ directory: base, timeoutMs: 40 * 60_000 });
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', qaApp.appDir], cwd: root, env: environment(), timeout: 60_000 });
  const electronLog = createWriteStream(join(base, 'chat-slash-electron.log'));
  app.process().stdout?.pipe(electronLog); app.process().stderr?.pipe(electronLog);
  app.process().on('exit', (code, signal) => { report.measurements.appExit = { code, signal }; console.log(`electron exited code=${code} signal=${signal}`); });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm?.request));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 45_000 });
  await settings({ language: 'en', theme: 'light', notifications: { ...NOTIFICATIONS, island: false } });
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  check('isolated app launched with notifications off');

  await until(async () => (await request('plugin.list')).plugins.find(plugin => plugin.id === 'prompt-queue-echo-acp'), 'the fixture is discovered');
  await request('plugin.setEnabled', { pluginId: 'prompt-queue-echo-acp', enabled: true, operationId: randomUUID() });
  const provider = await until(async () => (await request('provider.list')).find(item => item.id === 'queue-echo' && item.chat), 'Queue Echo is enabled');

  const create = async title => {
    const session = await request('session.create', { cwd: work, title, provider: 'queue-echo', mode: 'chat', operationId: randomUUID() });
    await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
    return session;
  };
  const composer = () => page.locator('.chat-compose-shell textarea');
  const send = async text => {
    const box = composer();
    await box.waitFor();
    await until(() => box.isEnabled(), 'the composer is enabled');
    await box.fill(text);
    await box.press('Enter');
    await until(async () => !(await box.inputValue()), `the composer clears for "${text}"`);
  };
  const slashMenu = () => page.locator('.chat-slash-menu');
  const names = () => slashMenu().locator('button[role="option"] b').allInnerTexts();
  const active = () => slashMenu().locator('button[aria-selected="true"] b').innerText();

  // 1. A Chat whose agent lists its own commands.
  await create('Slash QA');
  const box = composer();
  await box.waitFor();
  await until(() => box.isEnabled(), 'the composer is enabled');
  await until(async () => (await request('runtime.snapshot')).sessions.some(row => row.title === 'Slash QA'), 'the chat exists');

  // 2. "/" alone lists everything, ThreadTerm's commands first, under headings.
  await box.fill('/');
  await slashMenu().waitFor();
  await until(async () => (await names()).includes('/compact'), "the agent's commands arrive");
  const all = await names();
  const heads = await slashMenu().locator('.chat-slash-head').allInnerTexts();
  report.measurements.all = { all, heads };
  assert.equal(all[0], '/code-review', 'ThreadTerm comes first');
  assert.ok(all.includes('/review-pr'), 'the agent lists review-pr');
  assert.deepEqual(heads, ['ThreadTerm', 'Agent commands'], 'one heading per source');
  await shot(page, '01-slash-all.png');
  check(`"/" lists ThreadTerm's and the agent's commands under headings: ${all.join(' ')}`);

  // 3. A word inside a name matches, best first: "/rev" finds code-review and review-pr.
  await box.fill('/rev');
  await until(async () => (await names()).length === 2, 'two matches for /rev');
  assert.deepEqual(await names(), ['/review-pr', '/code-review'], 'a name that starts with the query beats a word inside one');
  assert.equal(await slashMenu().locator('.chat-slash-head').count(), 0, 'a ranked list has no headings');
  await shot(page, '02-slash-rev.png');
  check('"/rev" finds /review-pr and /code-review (a prefix-only match found nothing for code-review)');

  // 4. The keyboard: arrows wrap, a new query starts at its best match, Tab picks.
  await box.press('ArrowDown');
  assert.equal(await active(), '/code-review');
  await box.press('ArrowDown');
  assert.equal(await active(), '/review-pr', 'ArrowDown past the last row wraps to the first');
  await box.press('ArrowUp');
  assert.equal(await active(), '/code-review', 'ArrowUp past the first row wraps to the last');
  await box.fill('/co');
  await until(async () => (await active()) === '/compact' || (await active()) === '/code-review', 'the new query is highlighted');
  assert.equal(await active(), (await names())[0], 'a new query starts at its first match');
  await box.fill('/comp');
  await box.press('Tab');
  assert.equal(await box.inputValue(), '/compact ', 'Tab picks the highlighted command');
  check('arrows wrap, a new query starts at its best match, and Tab picks');

  // 5. Escape closes the menu and keeps the text; typing on opens it again.
  await box.fill('/rev');
  await slashMenu().waitFor();
  await box.press('Escape');
  await slashMenu().waitFor({ state: 'detached' });
  assert.equal(await box.inputValue(), '/rev', 'Escape keeps what was typed');
  await box.press('i');
  await slashMenu().waitFor();
  check('Escape closes the menu and keeps the text; typing opens it again');

  // 6. Many rows: the highlighted one stays in view.
  await box.fill('/');
  await slashMenu().waitFor();
  const count = (await names()).length;
  for (let step = 1; step < count; step += 1) await box.press('ArrowDown');
  const inView = await slashMenu().evaluate(menu => {
    const row = menu.querySelector('[aria-selected="true"]'); if (!row) return false;
    const a = menu.getBoundingClientRect(), b = row.getBoundingClientRect();
    return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
  });
  assert.equal(inView, true, 'the highlighted row is scrolled into view');
  const rows = await slashMenu().locator('button[role="option"]').evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().height)));
  assert.ok(rows.every(height => height === 32), `every row is one 32px line: ${rows.join(',')}`);
  await shot(page, '03-slash-keyboard.png');
  check('the highlighted row stays in view and every row is one 32px line');
  await box.fill('');

  report.passed = true;
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  console.error(error);
  process.exitCode = 1;
  await Promise.race([page?.screenshot({ path: join(out, 'failure-main.png') }), delay(5000)]).catch(() => {});
  await Promise.race([islandPage?.screenshot({ path: join(out, 'failure-island.png') }), delay(5000)]).catch(() => {});
} finally {
  if (app) await Promise.race([app.close(), delay(20_000)]).catch(error => report.errors.push(`Electron cleanup: ${error.message}`));
  await releaseLock?.().catch(() => {});
  await qaApp?.cleanup?.().catch(() => {});
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  console.log(JSON.stringify(report, null, 2));
}
