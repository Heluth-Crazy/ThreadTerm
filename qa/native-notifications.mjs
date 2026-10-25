// Real-app check of native (OS) notifications: consent and per-kind switches, the background-only rule, localized
// copy (English default, Chinese when chosen), Windows actually displaying the toast, a click opening the session,
// and the Settings "Send test notification" button.
// Isolated Electron (own data, user data and pipe; app bundle cached in the git-ignored runtime/target-qa folder,
// --rebuild after app changes) on the target-qa runtime. PATH holds only node and System32 (every case of PATH dropped
// first), so no agent CLI can start; the only process started is `cmd.exe /d /c exit N` in a terminal session.
// Real toasts appear on this desktop while it runs; one of them plays the notification sound (the sound switch check).
//   node qa/native-notifications.mjs [--rebuild] [--keep]
// Report and screenshots: qa/results/native-notifications/.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), `missing ${runtime}`);
const keep = process.argv.includes('--keep');
const delay = ms => new Promise(done => setTimeout(done, ms));
const scratch = await mkdtemp(join(tmpdir(), 'tt-notifications-'));
const work = join(scratch, 'work'), appDir = join(root, 'runtime/target-qa/notifications-qa-app');
const out = join(root, 'qa/results/native-notifications');
const report = { passed: false, scratch, checks: [], notes: [], toasts: [], errors: [] };
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const note = text => { report.notes.push(text); console.log(`NOTE ${text}`); };
let app, page, releaseLock;

async function prepare() {
  await mkdir(work, { recursive: true });
  if (process.argv.includes('--rebuild') || !existsSync(join(appDir, 'renderer', 'index.html'))) {
    console.log('building the QA app bundle…');
    await mkdir(appDir, { recursive: true });
    for (const name of ['main', 'preload']) {
      await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
    }
    await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-notifications-qa', version: '0.1.0', main: 'main.cjs' }));
  } else console.log(`reusing the QA app bundle in ${appDir} (--rebuild to rebuild)`);
}

const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(test, label, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) { try { const value = await test(); if (value) return value; } catch { /* retry */ } if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(200); }
}
const settingsPatch = async patch => { const { settings } = await request('runtime.snapshot'); await request('settings.update', { patch, expectedRevision: settings.revision, operationId: randomUUID() }); await delay(400); };
const toasts = () => app.evaluate(() => globalThis.__toasts.map(({ title, body, silent, shown, failed }) => ({ title, body, silent, shown, failed })));
const setFocus = async focused => {
  // blur() does not give up focus on Windows; minimizing puts ThreadTerm in the background like switching apps does.
  await app.evaluate(({ BrowserWindow }, value) => { const window = BrowserWindow.getAllWindows().find(item => item.isVisible() || item.isMinimized()); if (value) { window?.restore(); window?.show(); window?.focus(); } else window?.minimize(); }, focused);
  await delay(300);
  // The same test as main.ts: a minimized window can still report focus on Windows.
  return app.evaluate(({ BrowserWindow }) => { const focused = BrowserWindow.getFocusedWindow(); return !!focused && focused.isVisible() && !focused.isMinimized(); });
};
/** Starts a terminal that exits with `code`; resolves with the session once it has ended. */
async function finishingTerminal(title, code) {
  const session = await request('session.create', { cwd: work, title, provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/d', '/c', `exit ${code}`], operationId: randomUUID() });
  return until(async () => { const found = (await request('runtime.snapshot')).sessions.find(item => item.id === session.id); return found && !['starting', 'running', 'idle', 'waiting'].includes(found.status) ? found : undefined; }, `${title} ends`);
}
/** Waits briefly for the toast count to reach `count` (or stay below it when `none`). */
async function toastCount(count, none = false) {
  if (none) { await delay(2500); return (await toasts()).length; }
  await until(async () => (await toasts()).length >= count, `toast #${count}`, 15000);
  await until(async () => { const last = (await toasts())[count - 1]; return last.shown || last.failed; }, `toast #${count} shown or failed`, 8000).catch(() => undefined);
  return (await toasts()).length;
}

try {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await prepare();
  const dropped = /^(path|claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !dropped.test(name)));
  Object.assign(env, {
    Path: [dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-notifications-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_CLAUDE_NODE: process.execPath,
  });
  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => !document.getElementById('boot-splash'), null, { timeout: 30000 });
  // Record every OS notification the main process shows, and whether Windows displayed it.
  await app.evaluate(({ Notification }) => {
    globalThis.__toasts = [];
    const show = Notification.prototype.show;
    Notification.prototype.show = function () {
      const record = { title: this.title, body: this.body, silent: this.silent, shown: false, failed: null, target: this };
      globalThis.__toasts.push(record);
      this.once('show', () => { record.shown = true; });
      this.once('failed', (_event, error) => { record.failed = String(error); });
      return show.call(this);
    };
  });

  // 1. No consent: nothing reaches the OS, even in the background.
  assert.equal(await setFocus(false), false, 'the window can be put in the background');
  await finishingTerminal('qa no consent', 0);
  assert.equal(await toastCount(1, true), 0, 'no OS notification without "Allow system notifications"');
  check('without consent a finished terminal shows no OS notification');

  // 2. Consent on; ThreadTerm focused → the app itself is the notification.
  await settingsPatch({ notifications: { native: true, attention: true, completed: true, sound: false } });
  if (await setFocus(true)) {
    await finishingTerminal('qa focused', 0);
    assert.equal(await toastCount(1, true), 0, 'no OS notification while ThreadTerm has focus');
    check('while ThreadTerm has focus, session events stay in the app');
  } else note('the OS did not give the QA window focus; the focused rule is covered by unit tests only');

  // 3. Background: a finished terminal notifies, English by default, silent, and Windows displays it.
  await setFocus(false);
  const finished = await finishingTerminal('qa build', 0);
  assert.equal(await toastCount(1), 1);
  let [toast] = await toasts();
  assert.equal(toast.title, 'qa build'); assert.match(toast.body, /finished\./); assert.equal(toast.silent, true);
  assert.equal(toast.failed, null, `Windows reported a failure: ${toast.failed}`);
  check(`background completion → "${toast.title}: ${toast.body}" (silent, ${toast.shown ? 'displayed by Windows' : 'no show event yet'})`);
  if (!toast.shown) note('Windows did not confirm the toast with a show event within 8 s');

  // 4. A click on the notification brings ThreadTerm forward on that session.
  await page.evaluate(() => window.history.replaceState(null, '', window.location.href));
  await app.evaluate(() => globalThis.__toasts[0].target.emit('click'));
  await until(async () => (await page.locator('.session-screen, .ws, .pane-workspace').count()) > 0 && (await page.locator('body').innerText()).includes('qa build'), 'the clicked session is open', 10000);
  const focusedAfterClick = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() !== null);
  check(`clicking the notification opens session "${finished.title}"${focusedAfterClick ? ' and focuses ThreadTerm' : ''}`);
  await page.screenshot({ path: join(out, '01-after-click.png') });

  // 5. A failed terminal is an attention notice; turning attention off silences it, completions still come.
  await setFocus(false);
  await finishingTerminal('qa failing', 3);
  await toastCount(2);
  toast = (await toasts())[1];
  assert.match(toast.body, /exited with code 3\./);
  check(`a terminal that exits with 3 → "${toast.title}: ${toast.body}"`);
  await settingsPatch({ notifications: { native: true, attention: false, completed: true, sound: false } });
  await setFocus(false);
  await finishingTerminal('qa failing again', 3);
  assert.equal(await toastCount(3, true), 2, 'attention switched off → no notification for a non-zero exit');
  check('with "needs your attention" off, a failing terminal stays quiet');

  // 6. Chinese when chosen.
  await settingsPatch({ language: 'zh-CN', notifications: { native: true, attention: true, completed: true, sound: true } });
  await setFocus(false);
  const before = (await toasts()).length;
  await finishingTerminal('中文构建', 0);
  await toastCount(before + 1);
  toast = (await toasts())[before];
  assert.equal(toast.title, '中文构建'); assert.match(toast.body, /已结束/); assert.equal(toast.silent, false, 'sound switch on → not silent');
  check(`Chinese copy when chosen, with sound: "${toast.title}：${toast.body}"`);

  // 7. Settings → Send test notification shows a real toast even though Settings has focus.
  await settingsPatch({ language: 'en' });
  await setFocus(true);
  await page.locator('.user-row').click();
  await page.locator('.account-menu .shell-menu-foot .menu-item').click();
  await page.locator('.settings-panel [role=tab]', { hasText: 'Shortcuts' }).click();
  const sendTest = page.locator('.settings-panel button', { hasText: /Send test/ });
  const count = (await toasts()).length;
  await sendTest.click();
  await toastCount(count + 1);
  toast = (await toasts())[count];
  const receipt = await until(async () => { const text = await page.locator('.settings-panel .compatibility-settings p[role=status], .settings-panel p[role=status]').allInnerTexts(); return text.find(line => /notification/i.test(line) && !/No notification test/.test(line)); }, 'test receipt');
  assert.equal(toast.title, 'ThreadTerm notifications are on');
  check(`Settings test → toast "${toast.title}" and receipt "${receipt}"`);
  assert.equal(await page.locator('.settings-panel button', { hasText: /Preview notification/ }).count(), 0, 'the fake preview is gone');
  await page.screenshot({ path: join(out, '02-settings-notifications.png') });

  // 8. Consent off greys out the kind switches and the test explains why nothing was sent.
  await settingsPatch({ notifications: { native: false, attention: true, completed: true, sound: true } });
  const kindDisabled = await page.locator('.settings-panel .setting-switch input').evaluateAll(inputs => inputs.slice(1, 4).map(input => input.disabled));
  assert.deepEqual(kindDisabled, [true, true, true], 'kind and sound switches follow "Allow system notifications"');
  await sendTest.click();
  const refused = await until(async () => (await page.locator('.settings-panel p[role=status]').allInnerTexts()).find(line => /not sent/i.test(line)), 'refusal receipt');
  check(`consent off → kind switches disabled; test says "${refused}"`);
  await page.screenshot({ path: join(out, '03-settings-consent-off.png') });
  report.toasts = await toasts();
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(error);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  if (app) report.toasts = await toasts().catch(() => []);
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await Promise.race([app.close(), delay(5000)]).catch(() => {}); try { app.process()?.kill(); } catch { /* already gone */ } }
  await releaseLock?.();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed && !report.errors.length ? 'NATIVE NOTIFICATIONS QA PASSED' : `NATIVE NOTIFICATIONS QA FAILED\n${report.errors.join('\n')}`);
  process.exit(report.passed && !report.errors.length ? 0 : 1);
}
