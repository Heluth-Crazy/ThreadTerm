// Idle-cost regression for Settings (F16): an open Settings panel with Mobile access disabled must make zero periodic
// renderer→runtime RPCs, and the Retry panel must not tick without a pending retry. Desktop1 + isolated runtime/profile,
// no provider CLI on PATH (Detection finds none and the app must still be idle).
// Request counts come from a harness-only preload wrapper that counts ipcRenderer.invoke('threadterm:request'); the
// product preload is bundled unmodified.
//   node qa/idle-settings.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(import.meta.dirname, '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const out = join(root, 'qa/results/idle-settings');
const scratchBase = resolve(process.env.TEMP || tmpdir());
const scratch = await mkdtemp(join(scratchBase, 'tt-idle-settings-'));
const appDir = join(scratch, 'app'), work = join(scratch, 'work'), bin = join(scratch, 'bin');
const lock = resolve('D:/project/ThreadTerm/tt-qa-temp/qa-electron.lock');
const IDLE_MS = 6000;
const report = { passed: false, checks: [], idle: {}, screenshots: [], errors: [] };
let app, page, locked = false;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([method, params]) => window.threadterm.request(method, params), [method, params]);
const counts = () => page.evaluate(() => window.threadtermQaCounts.snapshot());
const resetCounts = () => page.evaluate(() => window.threadtermQaCounts.reset());
async function until(probe, label, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* retry until the deadline */ }
    if (Date.now() > end) throw Error(`Timed out: ${label}`);
    await sleep(150);
  }
}
function childEnv() {
  const value = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|temp|tmp|home|userprofile|homedrive|homepath|appdata|localappdata|codex_home|claude_config_dir|threadterm_v3_.*|tt_qa_.*)$/i.test(key)));
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  Object.assign(value, {
    TEMP: scratchBase, TMP: scratchBase,
    // Only node and System32: no real agent CLI can be discovered by accident.
    PATH: [bin, dirname(process.execPath), join(systemRoot, 'System32')].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-idle-settings-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
  });
  assert.equal(Object.keys(value).filter(key => key.toLowerCase() === 'path').length, 1, 'exactly one PATH variable');
  return value;
}
function preloadWrapper() {
  return `import { contextBridge, ipcRenderer } from 'electron';
import '${join(root, 'desktop/src/preload.ts').replaceAll('\\', '/')}';
// Harness-only: count renderer→runtime requests instead of touching the product preload.
const counts = new Map<string, number>();
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = ((channel: string, ...args: unknown[]) => {
  if (channel === 'threadterm:request') { const method = String(args[0]); counts.set(method, (counts.get(method) ?? 0) + 1); }
  return invoke(channel, ...args);
}) as typeof ipcRenderer.invoke;
contextBridge.exposeInMainWorld('threadtermQaCounts', {
  snapshot: () => Object.fromEntries(counts),
  reset: () => counts.clear(),
});
`;
}
async function shot(name) {
  await page.mouse.move(0, 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'));
  const png = await app.evaluate(async ({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; const [width, height] = window.getContentSize(); return (await window.webContents.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true })).toPNG().toString('base64'); });
  await writeFile(join(out, name), Buffer.from(png, 'base64'));
  report.screenshots.push(name);
}
async function shotElement(selector, name) {
  await page.mouse.move(0, 0);
  await page.locator(selector).screenshot({ path: join(out, name), animations: 'disabled' });
  report.screenshots.push(name);
}
async function applySettings(language, theme) {
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language, theme, themeSelection: theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(({ language, theme }) => document.documentElement.lang === language && document.documentElement.dataset.theme === theme, { language, theme });
}
async function openSettings(tab) {
  // The Workbench route has no legacy toolbar; Settings lives in the account menu.
  await page.locator('.user-row').click();
  await page.locator('.account-menu').getByRole('button', { name: /^(Settings|设置)$/ }).click();
  await page.locator('.settings-panel').waitFor();
  await page.getByRole('tab', { name: tab }).click();
  await page.locator('.settings-group.active').waitFor();
}
async function closeSettings() {
  await page.getByRole('button', { name: /^(Close settings|关闭设置)$/ }).click();
  await page.locator('.settings-panel').waitFor({ state: 'detached' });
}
async function idle(label) {
  await sleep(1200);
  await resetCounts();
  await sleep(IDLE_MS);
  const seen = await counts();
  const total = Object.values(seen).reduce((sum, value) => sum + value, 0);
  report.idle[label] = { windowMs: IDLE_MS, total, methods: seen };
  console.log(`idle ${label}: ${JSON.stringify(seen)}`);
  return { total, seen };
}

try {
  assert.ok(existsSync(runtime), `missing ${runtime}`);
  await Promise.all([out, appDir, work, bin].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(scratch, 'preload-entry.ts'), preloadWrapper());
  await esbuild({ entryPoints: [join(root, 'desktop/src/main.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, 'main.cjs'), logLevel: 'error' });
  await esbuild({ entryPoints: [join(scratch, 'preload-entry.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, 'preload.cjs'), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true, minify: false } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'idle-settings-qa', version: '0.1.0', main: 'main.cjs' }));

  const deadline = Date.now() + 40 * 60 * 1000;
  for (;;) {
    try { await mkdir(lock); locked = true; break; } catch (error) { if (error.code !== 'EEXIST' || Date.now() > deadline) throw error; console.log('Waiting for shared Electron QA lock'); await sleep(15_000); }
  }
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: root, env: childEnv(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('#boot-splash').waitFor({ state: 'detached' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await until(() => page.evaluate(() => Boolean(window.threadtermQaCounts)), 'request counter');
  assert.equal((await request('device.status')).enabled, false, 'remote access starts disabled');

  await applySettings('en', 'light');
  await openSettings('Appearance');
  const appearance = await idle('appearance-remote-disabled');
  assert.equal(appearance.seen['device.status'], undefined, `Appearance must not poll device.status: ${JSON.stringify(appearance.seen)}`);
  assert.equal(appearance.seen['device.list'], undefined, `Appearance must not poll device.list: ${JSON.stringify(appearance.seen)}`);
  assert.equal(appearance.total, 0, `an idle app with Settings → Appearance open must make no RPCs: ${JSON.stringify(appearance.seen)}`);
  check(`Settings → Appearance with remote disabled makes zero RPCs in ${IDLE_MS} ms`);
  await shot('en-light-devices-appearance.png');

  await page.getByRole('tab', { name: 'Mobile' }).click();
  await page.locator('.device-settings').waitFor();
  const mobile = await idle('mobile-remote-disabled');
  assert.equal(mobile.seen['device.status'], undefined, `the open Mobile tab must not poll device.status: ${JSON.stringify(mobile.seen)}`);
  assert.equal(mobile.seen['device.list'], undefined, `the open Mobile tab must not poll device.list: ${JSON.stringify(mobile.seen)}`);
  assert.equal(mobile.total, 0, `the open Mobile tab with remote disabled must stay idle: ${JSON.stringify(mobile.seen)}`);
  check(`Settings → Mobile with remote disabled loads on open and then makes zero RPCs in ${IDLE_MS} ms`);
  await shot('en-light-devices.png');

  // Hiding the tab keeps the mounted panel quiet; returning to it refreshes once.
  await page.getByRole('tab', { name: 'Appearance' }).click();
  const hiddenMobile = await idle('mobile-tab-hidden');
  assert.equal(hiddenMobile.total, 0, `an inactive Mobile tab must stay quiet: ${JSON.stringify(hiddenMobile.seen)}`);
  await resetCounts();
  await page.getByRole('tab', { name: 'Mobile' }).click();
  await until(async () => ((await counts())['device.status'] ?? 0) >= 1, 'device.status on tab re-open');
  check('leaving the Mobile tab stops its work and returning refreshes it once');
  await closeSettings();

  // Retry panel: the clock only appears for a pending retry, so an idle terminal dialog makes no RPCs either.
  const project = await request('project.add', { path: work, name: 'Idle QA', operationId: randomUUID() });
  const session = await request('session.create', { projectId: project.id, cwd: work, title: 'Idle terminal', provider: 'shell', mode: 'terminal', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.locator('.runtime-workspace').waitFor();
  await page.getByRole('button', { name: 'Session details', exact: true }).click();
  await page.locator('.inspector').waitFor();
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  await page.locator('.retry-settings').waitFor();
  const retry = await idle('retry-dialog-no-pending');
  assert.equal(retry.seen['session.retry.read'], undefined, `a Retry panel without a pending retry must not reload: ${JSON.stringify(retry.seen)}`);
  assert.equal(retry.seen['session.retry.update'], undefined, `a Retry panel without a pending retry must not save: ${JSON.stringify(retry.seen)}`);
  check(`the Retry panel without a pending retry makes no retry RPCs in ${IDLE_MS} ms`);

  // F21: a typed maximum must survive unrelated session events.
  const maximum = page.locator('.retry-settings input[type=number]');
  await page.locator('.retry-settings .retry-toggle input').click();
  await until(() => maximum.isEnabled(), 'retry maximum enabled');
  await maximum.fill('3');
  await maximum.press('Tab');
  await request('session.create', { projectId: project.id, cwd: work, title: 'Unrelated session', provider: 'shell', mode: 'terminal', operationId: randomUUID() });
  await sleep(1200);
  assert.equal(await maximum.inputValue(), '3', 'a typed maximum survives another session launching');
  check('a typed retry maximum survives another session launching');
  await shotElement('.retry-settings', 'en-light-retry.png');

  for (const [language, theme, mobileTab] of [
    ['en', 'dark', 'Mobile'],
    ['zh-CN', 'light', '移动'],
    ['zh-CN', 'dark', '移动'],
  ]) {
    const label = `${language}-${theme}`;
    await applySettings(language, theme);
    if (!(await page.locator('.retry-settings').count())) {
      if (!(await page.locator('.inspector').count())) await page.getByRole('button', { name: /^(Session details|会话详情面板)$/, exact: true }).click();
      await page.getByRole('button', { name: /^(Configure|配置)$/, exact: true }).click();
      await page.locator('.retry-settings').waitFor();
    }
    await shotElement('.retry-settings', `${label}-retry.png`);
    await page.locator('.dialog.session-config .icon-btn').click();
    await page.locator('.dialog.session-config').waitFor({ state: 'detached' });
    await openSettings(mobileTab);
    await page.locator('.device-settings').waitFor();
    await shot(`${label}-devices.png`);
    await closeSettings();
  }

  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  if (page) await shot('failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  if (locked) await rm(lock, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  if (report.errors.length) report.passed = false;
  console.log(report.passed ? 'IDLE SETTINGS QA PASSED' : `IDLE SETTINGS QA FAILED\n${report.errors.join('\n')}`);
  process.exitCode = report.passed ? 0 : 1;
}
