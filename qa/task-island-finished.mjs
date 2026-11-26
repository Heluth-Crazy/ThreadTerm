// Task island QA for a finished turn (owner report 2026-11-26: 「任务岛无法点击，出现完成后，点击查看，也无法唤出，鼠标样式
// 悬浮到任务岛时发生了变化，但是点击没有任何变化」). The real desktop app, the debug runtime and the Prompt Queue Echo ACP
// fixture: one Chat turn finishes while ThreadTerm is minimized, and the 完成 card is used the way a person would: the
// pointer rests on it past the card's own time, the OS must route a click there to the island (WindowFromPoint; the
// real cursor never moves), and View must bring ThreadTerm back on that session. Screenshots go to
// qa/results/task-island-finished/.
//
// desktop1 never lets a QA window take focus, so "ThreadTerm is in the background" holds by itself here. The OS cursor
// is simulated in main (`screen.getCursorScreenPoint`), as in qa/task-island-visual.mjs.
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
const out = join(root, 'qa/results/task-island-finished');
const scratch = await mkdtemp(join(base, 'tt-task-island-finished-'));
const bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins'), work = join(scratch, 'work');
const data = join(scratch, 'data'), profile = join(scratch, 'profile'), pipe = `\\\\.\\pipe\\tt-task-island-finished-${randomUUID()}`;
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
  const electronLog = createWriteStream(join(base, 'island-finished-electron.log'));
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
      try { globalThis.__qaIsland.ignore.push({ ignore, forward: options?.forward === true, island: this.webContents?.getURL?.().includes('island.html') === true }); } catch { /* a destroyed window */ }
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
  const islandWindow = () => app.evaluate(({ BrowserWindow }) => {
    const island = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('island.html'));
    const raw = island.getNativeWindowHandle();
    return { handle: (raw.length >= 8 ? raw.readBigUInt64LE(0) : BigInt(raw.readUInt32LE(0))).toString(), bounds: island.getBounds() };
  });
  const placeCursor = point => app.evaluate(({ screen }, at) => {
    globalThis.__qaIsland.realCursor ??= screen.getCursorScreenPoint;
    screen.getCursorScreenPoint = () => ({ x: at.x, y: at.y });
  }, point);
  const center = async locator => {
    const box = await locator.boundingBox();
    assert.ok(box, 'the element is laid out');
    const { bounds } = await islandWindow();
    return { x: Math.round(bounds.x + box.x + box.width / 2), y: Math.round(bounds.y + box.y + box.height / 2) };
  };
  /**
   * Whether the OS would hand the island a click at this DIP point, asked of the island window itself so a lock screen
   * or another app on top cannot answer instead (WindowFromPoint returns the lock screen's LockScreenBackstopFrame on a
   * locked PC): no WS_EX_TRANSPARENT (0x20) in its extended style, and WM_NCHITTEST at the point says HTCLIENT (1), not
   * HTTRANSPARENT (-1) or HTNOWHERE (0).
   */
  const islandHit = async (handle, point) => {
    const physical = await app.evaluate(({ screen }, at) => screen.dipToScreenPoint(at), point);
    const script = [
      "Add-Type -Namespace Qa -Name Hit -MemberDefinition '[DllImport(\"user32.dll\")] public static extern int GetWindowLong(IntPtr h, int i); [DllImport(\"user32.dll\")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'",
      `$h = [IntPtr]${handle}`, `$l = [IntPtr](((${physical.y} -band 0xffff) -shl 16) -bor (${physical.x} -band 0xffff))`,
      "'{0} {1}' -f [Qa.Hit]::GetWindowLong($h, -20), [Qa.Hit]::SendMessage($h, 0x84, [IntPtr]::Zero, $l).ToInt64()",
    ].join('; ');
    const [style, test] = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 }).trim().split(' ').map(Number);
    return { transparent: (style & 0x20) !== 0, hitTest: test, physical };
  };
  const mainState = () => app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(row => !row.webContents.getURL().includes('island.html'));
    return { visible: window.isVisible(), minimized: window.isMinimized() };
  });
  const mainWindowDo = action => app.evaluate(({ BrowserWindow }, name) => BrowserWindow.getAllWindows().find(row => !row.webContents.getURL().includes('island.html'))?.[name](), action);
  const background = async () => { await mainWindowDo('minimize'); await emitWindowEvent('browser-window-blur'); };
  const view = () => islandPage.getByRole('button', { name: 'View', exact: true });
  const announced = async () => (await islandPage.getByText('Done', { exact: true }).count()) > 0 || (await view().count()) > 0;

  // 1. A turn that finishes while ThreadTerm is minimized.
  const finishing = await create('Island finish QA');
  await send('slow:4000 Finishing island turn');
  await until(async () => (await request('runtime.snapshot')).sessions.find(row => row.id === finishing.id)?.status === 'running', 'the turn runs');
  await background();
  await (await openIsland()).locator('.ti-stage.is-on').waitFor();
  check('minimized ThreadTerm shows the island while the turn runs');

  // 2. The 完成 card: expanded by its alert, or by a click on the compact card.
  await until(announced, 'the island announces the finished turn', 20_000);
  const announcedAt = Date.now();
  if (!(await view().count())) await islandPage.locator('.ti-stage').click({ position: { x: 220, y: 20 } });
  await view().waitFor();
  await shot(islandPage, '01-finished-card.png');
  check('the finished turn shows a 完成 card with View');

  // 3. The pointer on View: main sees it there, the window starts catching clicks, and the OS routes a click to it.
  const target = await center(view());
  await placeCursor(target);
  await until(async () => (await islandCalls()).at(-1)?.ignore === false, 'the pointer over View makes the island catch clicks');
  const { handle } = await islandWindow();
  const hit = await islandHit(handle, target);
  report.measurements.hit = { target, ...hit };
  assert.equal(hit.transparent, false, 'catching clicks, the island window is not WS_EX_TRANSPARENT');
  assert.equal(hit.hitTest, 1, `the island answers HTCLIENT at View (WM_NCHITTEST ${hit.hitTest})`);
  check('the pointer over View makes the island catch clicks, and the OS hands a click there to the island');

  // 4. A person takes longer than the card's own few seconds: it stays while the pointer rests on it.
  await delay(Math.max(0, announcedAt + 8_000 - Date.now()));
  assert.equal(await view().count(), 1, 'View is still there 8 s after the card appeared, with the pointer on it');
  check('the card stays past its own time while the pointer rests on it');

  // 5. View brings ThreadTerm back from the taskbar on that session.
  await view().click();
  await until(async () => { const state = await mainState(); return state.visible && !state.minimized; }, 'View restores the minimized main window');
  const navigation = await until(async () => (await navigations()).at(-1), 'the island asks for the finished session');
  assert.equal(navigation.sessionId, finishing.id, 'View opens the session that finished');
  await shot(page, '02-view-opens-session.png');
  check('View restores the minimized main window on the finished session');

  // 6. Without the pointer on it, a card does not stay forever.
  await placeCursor({ x: -5000, y: -5000 });
  const second = await create('Island finish QA 2');
  await send('slow:1500 Second finishing turn');
  await background();
  await until(announced, 'the second turn is announced', 20_000);
  await until(async () => !(await announced()), 'the card leaves once its time is up', 20_000);
  check('without the pointer on it, the card leaves once its time is up');

  // 7. A View that reaches main after its card left (a slow click, the exit animation) still opens that session.
  const before = (await navigations()).length;
  await islandPage.evaluate(sessionId => window.threadtermIsland.open(`local\u0000${sessionId}`), second.id);
  const late = await until(async () => (await navigations()).slice(before).at(-1), 'a late View still opens the session', 10_000);
  assert.equal(late.sessionId, second.id, 'the late View opens the session it named');
  check('a View that arrives after its card left still opens that session');

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
