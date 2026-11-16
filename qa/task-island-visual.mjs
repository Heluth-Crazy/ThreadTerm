// Task island QA: the real desktop app, the debug runtime and the Prompt Queue Echo ACP fixture. One Chat session
// holds a slow turn, another asks for permission; the island window is then observed while ThreadTerm is in the
// background. Screenshots go to qa/results/task-island/.
//
// desktop1 (qa/lib/desktop1.mjs) never lets a QA window take focus, so the "ThreadTerm is in front" half of the
// island's rule is played by answering Electron's own `BrowserWindow.getFocusedWindow` from this harness — a stub in
// the app's main process, not a product change. `setIgnoreMouseEvents` has no getter, so the recorder below observes
// the calls instead, and the native extended window style proves the taskbar/focus flags.
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
const out = join(root, 'qa/results/task-island');
const scratch = await mkdtemp(join(base, 'tt-task-island-'));
const bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins'), work = join(scratch, 'work');
const data = join(scratch, 'data'), profile = join(scratch, 'profile'), pipe = `\\\\.\\pipe\\tt-task-island-${randomUUID()}`;
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
  const electronLog = createWriteStream(join(base, 'island-electron.log'));
  app.process().stdout?.pipe(electronLog); app.process().stderr?.pipe(electronLog);
  app.process().on('exit', (code, signal) => { report.measurements.appExit = { code, signal }; console.log(`electron exited code=${code} signal=${signal}`); });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm?.request));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 45_000 });
  await settings({ language: 'en', theme: 'light', notifications: { ...NOTIFICATIONS, island: true } });
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  check('isolated app launched with the island on and system notifications off');

  // Observation points inside the app's main process (harness only; desktop/ is untouched).
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__qaIsland = { ignore: [], navigations: [], focused: BrowserWindow.getFocusedWindow };
    const original = BrowserWindow.prototype.setIgnoreMouseEvents;
    BrowserWindow.prototype.setIgnoreMouseEvents = function setIgnoreMouseEvents(ignore, options) {
      try { globalThis.__qaIsland.ignore.push({ ignore, island: this.webContents?.getURL?.().includes('island.html') === true }); } catch { /* a destroyed window */ }
      return original.call(this, ignore, options);
    };
    const window = BrowserWindow.getAllWindows().find(row => !row.webContents.getURL().includes('island.html'));
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...rest) => {
      if (channel === 'threadterm:desktop-navigate') globalThis.__qaIsland.navigations.push(rest[0]);
      return send(channel, ...rest);
    };
  });

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
  const openIsland = async () => {
    const entry = await until(() => findWindow('island.html'), 'the island window appears', 20_000);
    assert.equal(entry.visible, true, 'the island window is shown');
    const candidate = app.windows().find(row => row.url().includes('island.html'));
    assert.ok(candidate, 'the island page is reachable');
    if (candidate !== islandPage) {
      islandPage = candidate;
      islandPage.setDefaultTimeout(20_000);
      islandPage.on('pageerror', error => report.errors.push(`island page: ${error.message}`));
      islandPage.on('console', message => { if (message.type() === 'error') report.errors.push(`island console: ${message.text()}`); });
      await islandPage.waitForLoadState('domcontentloaded');
    }
    return islandPage;
  };

  // 1. A running turn while ThreadTerm is in the background.
  const running = await create('Island QA task');
  await send('slow:15000 Running island turn');
  await until(async () => (await request('runtime.snapshot')).sessions.find(row => row.id === running.id)?.status === 'running', 'the slow turn runs');
  check(`a Chat session runs on ${provider.name}`);

  await hideMainWindow();
  await emitWindowEvent('browser-window-blur');
  await (await openIsland()).locator('.ti-stage.is-on').waitFor();
  const title = (await request('runtime.snapshot')).sessions.find(row => row.id === running.id).title;
  await until(async () => (await islandPage.locator('.ti-label').first().innerText()).trim().length > 0, 'the compact pill is labelled');
  const pill = { label: (await islandPage.locator('.ti-label').first().innerText()).trim(), time: (await islandPage.locator('.ti-time').first().innerText()).trim() };
  assert.equal(pill.label, title, 'the pill names the running session');
  assert.match(pill.time, /^\d+:\d{2}$/, 'the pill shows the elapsed time');
  report.measurements.pill = pill;
  await shot(islandPage, '01-running-pill.png');
  check(`hidden ThreadTerm shows the island pill: "${pill.label}" ${pill.time}`);

  // 2. Click-through everywhere but the island: the pointer over the pill asks main to catch clicks, leaving it hands
  //    them back.
  await islandPage.mouse.move(220, 20);
  await until(async () => (await islandCalls()).some(call => call.ignore === false), 'the island catches the pointer');
  await islandPage.mouse.move(10, 360);
  await until(async () => (await islandCalls()).at(-1)?.ignore === true, 'the transparent rest passes clicks through');
  report.measurements.ignoreMouseEvents = await islandCalls();
  check('the window ignores the mouse outside the pill and catches it over the pill');

  // 3. ThreadTerm in front again: the island goes away. (The window has to be on screen for `appFocused` to count it,
  //    which is what showing it models here.)
  await showMainWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getFocusedWindow = () => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('island.html')) ?? null;
  });
  await emitWindowEvent('browser-window-focus');
  await until(async () => (await findWindow('island.html'))?.visible === false, 'the island hides while ThreadTerm is in front', 10_000);
  await until(async () => (await islandPage.locator('.ti-stage.is-on').count()) === 0, 'the island page fades out');
  assert.equal((await islandCalls()).at(-1)?.ignore, true, 'a hidden island stops catching clicks');
  check('ThreadTerm in front hides the island window and fades the stage out');

  // 4. An approval: the island expands with Later / Review.
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getFocusedWindow = globalThis.__qaIsland.focused; });
  await emitWindowEvent('browser-window-blur');
  await settle();
  const waiting = await create('Needs your approval');
  await send('approval please');
  await until(async () => (await request('runtime.snapshot')).sessions.find(row => row.id === waiting.id)?.status === 'waiting', 'the approval turn waits');
  await openIsland();
  await until(async () => (await findWindow('island.html'))?.visible === true, 'the island is back with the approval');
  const review = islandPage.getByRole('button', { name: 'Review', exact: true });
  await review.waitFor({ timeout: 20_000 });
  assert.equal(await islandPage.getByRole('button', { name: 'Later', exact: true }).count(), 1, 'the island offers Later beside Review');
  const expanded = {
    head: (await islandPage.locator('.ti-h1').first().innerText()).trim(),
    sub: (await islandPage.locator('.ti-h2').first().innerText()).trim(),
    detail: (await islandPage.locator('.ti-detail').first().innerText()).replace(/\s+/g, ' ').trim(),
  };
  report.measurements.approval = expanded;
  assert.match(expanded.head, /needs approval/i, 'the island names what the agent wants from the user');
  // The head, its subtitle and the elapsed time share one row: a long provider name must not run under the time.
  await delay(2500);
  const layout = await islandPage.evaluate(() => {
    const box = selector => { const node = document.querySelector(selector); if (!node) return undefined; const rect = node.getBoundingClientRect(); return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), text: (node.textContent ?? '').trim() }; };
    return { head: box('.ti-head'), title: box('.ti-h1'), time: box('.ti-time'), detail: box('.ti-detail') };
  });
  report.measurements.approvalLayout = layout;
  assert.ok(layout.time && layout.title, 'the expanded head and its time are laid out');
  assert.ok(layout.title.right <= layout.time.left + 0.5, `the title stays clear of the elapsed time ${JSON.stringify(layout)}`);
  await shot(islandPage, '02-approval-expanded.png');
  check(`the approval expands the island: "${expanded.head}" / "${expanded.detail}"`);

  // 5. Review brings the main window forward on that session (never approves from the island).
  await request('session.present', { sessionId: running.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await review.click();
  await until(async () => (await findWindow('index.html'))?.visible === true, 'Review shows the main window');
  const navigation = await until(async () => (await navigations()).at(-1), 'the island asks for the waiting session');
  assert.equal(navigation.sessionId, waiting.id, 'the island opens the session it was announcing');
  const pending = (await request('chat.snapshot', { sessionId: waiting.id })).items.some(item => item.parts.some(part => part.type === 'approval' && part.status === 'pending'));
  assert.equal(pending, true, 'the approval is still pending: the island never approves');
  await shot(page, '03-review-opens-main-window.png');
  check('Review opens the waiting session in the main window with the approval still pending');

  // 6. The window itself: not focusable, always on top, never in the taskbar, click-through by default.
  const flags = await app.evaluate(({ BrowserWindow }) => {
    const island = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('island.html'));
    const raw = island.getNativeWindowHandle();
    return {
      handle: (raw.length >= 8 ? raw.readBigUInt64LE(0) : BigInt(raw.readUInt32LE(0))).toString(),
      focusable: island.isFocusable(), alwaysOnTop: island.isAlwaysOnTop(), resizable: island.isResizable(), movable: island.isMovable(),
      minimizable: island.isMinimizable(), maximizable: island.isMaximizable(), bounds: island.getBounds(),
    };
  });
  const exStyle = nativeExStyle(flags.handle);
  report.measurements.window = { ...flags, exStyle: `0x${(exStyle >>> 0).toString(16)}` };
  assert.equal(flags.focusable, false, 'the island cannot take focus');
  assert.equal(flags.alwaysOnTop, true, 'the island stays on top');
  assert.equal(flags.resizable || flags.movable || flags.minimizable || flags.maximizable, false, 'the island is a fixed, unmovable panel');
  // WS_EX_NOACTIVATE takes the window out of the taskbar and Alt+Tab as well; skipTaskbar: true (desktop/src/taskIsland.ts)
  // says the same thing to the shell's taskbar list, which no getter can read back.
  assert.equal((exStyle & 0x08000000) !== 0, true, `WS_EX_NOACTIVATE keeps the island out of focus (0x${(exStyle >>> 0).toString(16)})`);
  assert.equal((exStyle & 0x8) !== 0, true, 'the island is topmost');
  const firstIgnore = (await islandCalls())[0];
  assert.equal(firstIgnore?.ignore, true, 'a new island window starts click-through');
  check(`the island window is a non-activating, topmost, fixed panel (${report.measurements.window.exStyle}): no focus, no taskbar button`);

  // 7. The setting turns the island off, and back on.
  await settings({ notifications: { ...NOTIFICATIONS, island: false } });
  await until(async () => !(await findWindow('island.html')), 'the island window goes away when the setting is off', 15_000);
  check('notifications.island=false removes the island window');
  await settings({ notifications: { ...NOTIFICATIONS, island: true } });
  await until(async () => (await findWindow('island.html'))?.visible === true, 'the island returns when the setting is on again', 20_000);
  check('turning the setting back on brings the island back');

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
