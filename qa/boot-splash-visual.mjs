// Real-app check of the launch screen (prototypes/app-loading → renderer/index.html + src/bootSplash.ts): it is in
// the window's first paint, holds while the runtime is still starting, never disappears before the app has loaded,
// hands over as soon as its finale ends, remembers theme + language for the next launch, honours reduced motion,
// and clears promptly when the runtime cannot start.
// Isolated Electron (own data, user data, pipe and app bundle in disposable scratch;
// desktop-dist and renderer/dist untouched) on the target-qa runtime. No providers are
// needed: PATH holds only node and System32 (every case of PATH dropped first), so no agent CLI can start.
// The slow start is real: the runtime is launched through a shim that waits SLOW_MS before starting it.
//   node qa/boot-splash-visual.mjs [--rebuild] [--keep]
// Screenshots: qa/results/boot-splash/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const SLOW_MS = 5000;
const delay = ms => new Promise(done => setTimeout(done, ms));
const scratch = await mkdtemp(join(tmpdir(), 'tt-boot-splash-'));
const bin = join(scratch, 'bin'), appDir = join(scratch, 'app');
const out = join(root, 'qa/results/boot-splash');
const report = { passed: false, scratch, checks: [], notes: [], shots: [], errors: [] };
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const note = text => { report.notes.push(text); console.log(`NOTE ${text}`); };
let app, page, releaseLock;

async function prepare() {
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'slow-runtime.rs'), 'fn main(){let ms:u64=std::env::var("TT_QA_RUNTIME_DELAY_MS").ok().and_then(|v|v.parse().ok()).unwrap_or(5000);std::thread::sleep(std::time::Duration::from_millis(ms));let status=std::process::Command::new(std::env::var_os("TT_QA_REAL_RUNTIME").expect("TT_QA_REAL_RUNTIME")).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
  const compiled = spawnSync('rustc', ['-O', join(bin, 'slow-runtime.rs'), '-o', join(bin, 'slow-runtime.exe')], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  if (process.argv.includes('--rebuild') || !existsSync(join(appDir, 'renderer', 'index.html'))) {
    console.log('building the QA app bundle…');
    await mkdir(appDir, { recursive: true });
    for (const name of ['main', 'preload']) {
      await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
    }
    await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-boot-splash-qa', version: '0.1.0', main: 'main.cjs' }));
  } else console.log(`reusing the QA app bundle in ${appDir} (--rebuild to rebuild)`);
}

function environment(name, runtimeExecutable) {
  const dropped = /^(path|claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !dropped.test(key)));
  return Object.assign(env, {
    Path: [dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, name, 'data'), THREADTERM_V3_USER_DATA: join(scratch, name, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-boot-splash-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtimeExecutable,
    THREADTERM_CLAUDE_NODE: process.execPath,
    TT_QA_REAL_RUNTIME: runtime, TT_QA_RUNTIME_DELAY_MS: String(SLOW_MS),
  });
}

async function launch(name, runtimeExecutable) {
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: root, env: environment(name, runtimeExecutable), timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 });
  page.on('pageerror', error => report.errors.push(`${name}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`${name} console: ${message.text()}`); });
  await recordTimeline();
}

/** Samples the launch screen and the app behind it on every frame, from as early as the page lets us in. */
async function recordTimeline() {
  await page.evaluate(() => {
    const log = window.__splashLog = { entries: [], started: performance.now() };
    let last = '';
    const sample = () => {
      const splash = document.getElementById('boot-splash');
      const loading = !!document.querySelector('.content.main > .state > .spinner');
      const appReady = !!document.querySelector('.app-shell .content.main') && !loading;
      const entry = { present: !!splash, phase: splash?.dataset.phase ?? null, status: splash?.querySelector('.bs-status-text')?.textContent ?? null, appReady, opacity: splash ? Number(getComputedStyle(splash).opacity) : 0 };
      const key = JSON.stringify({ ...entry, opacity: entry.opacity === 1 ? 1 : entry.opacity === 0 ? 0 : 'fading' });
      if (key !== last) { last = key; log.entries.push({ at: Math.round(performance.now()), ...entry }); }
      if (splash || !appReady) requestAnimationFrame(sample);
      else log.done = true;
    };
    sample();
  });
}
const timeline = () => page.evaluate(() => window.__splashLog);
async function waitForTimelineEnd(label) {
  await page.waitForFunction(() => window.__splashLog?.done === true, null, { timeout: 30000 }).catch(() => { throw Error(`launch screen never handed over (${label})`); });
  return timeline();
}
// Playwright can attach well after navigation under load; sample offsets start with this splash timeline.
const at = ms => page.waitForFunction(value => performance.now() - window.__splashLog.started >= value, ms, { timeout: 30000 });
const shot = async name => { await page.screenshot({ path: join(out, name) }); report.shots.push(name); };

/** The launch screen may only be gone once the app has rendered; returns the hand-over latency. */
function assertHandOver(log, label, maxLatency) {
  const first = log.entries[0];
  assert.ok(first.present, `${label}: the launch screen is up at the first sample`);
  const gone = log.entries.find(entry => !entry.present);
  assert.ok(gone, `${label}: the launch screen was removed`);
  const early = log.entries.find(entry => !entry.present && !entry.appReady);
  assert.equal(early, undefined, `${label}: the launch screen never left while the app was still loading`);
  const ready = log.entries.find(entry => entry.appReady);
  assert.ok(ready && ready.at <= gone.at, `${label}: the app rendered before the launch screen left`);
  const fadingWhileLoading = log.entries.find(entry => entry.present && entry.opacity < 1 && !entry.appReady);
  assert.equal(fadingWhileLoading, undefined, `${label}: no exit fade before the app had rendered`);
  const latency = gone.at - ready.at;
  assert.ok(latency <= maxLatency, `${label}: handed over ${latency} ms after the app rendered (max ${maxLatency})`);
  return { latency, total: gone.at, ready: ready.at, sampledFrom: Math.round(log.started) };
}

async function teardown() {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await Promise.race([app.close(), delay(5000)]).catch(() => {}); try { app.process()?.kill(); } catch { /* already gone */ } }
  app = undefined; page = undefined;
}

try {
  await mkdir(out, { recursive: true });
  releaseLock = await acquireElectronQaLock();
  await prepare();

  // 1. Cold start with a slow runtime: no saved appearance yet (system theme, English default).
  console.log(`slow runtime (${SLOW_MS} ms) …`);
  await launch('slow', join(bin, 'slow-runtime.exe'));
  await at(520); await shot('01-float-slow.png');
  await at(1500); await shot('02-converge-slow.png');
  await page.waitForFunction(() => document.getElementById('boot-splash')?.dataset.phase === 'hold', null, { timeout: 10000 });
  await at(3600);
  const holding = await page.evaluate(() => ({ phase: document.getElementById('boot-splash')?.dataset.phase, status: document.querySelector('#boot-splash .bs-status-text')?.textContent, loading: !!document.querySelector('.content.main > .state > .spinner'), fill: document.querySelector('#boot-splash .bs-progress i')?.style.transform }));
  assert.equal(holding.phase, 'hold', 'holding at the gate while the runtime is still starting');
  assert.equal(holding.loading, true, 'the app behind is genuinely still loading');
  assert.equal(holding.status, 'Connecting to the local runtime', 'the status names the step that is actually pending');
  check(`holds while the runtime starts (3.6 s: phase hold, status "${holding.status}", bar ${holding.fill})`);
  await shot('03-hold-slow.png');
  await page.waitForFunction(() => document.getElementById('boot-splash')?.dataset.phase === 'finale', null, { timeout: 20000 });
  await shot('04-finale-slow.png');
  const slow = assertHandOver(await waitForTimelineEnd('slow'), 'slow runtime', 1100);
  assert.ok(slow.ready > SLOW_MS, `the app only rendered after the delayed runtime (${slow.ready} ms)`);
  check(`slow start: app rendered at ${slow.ready} ms, launch screen handed over ${slow.latency} ms later (finale + fade), never before`);
  await delay(300); await shot('05-app-after-slow.png');

  // 2. Saved appearance: dark + English, then a relaunch of the window against the now-warm runtime.
  const { settings } = await page.evaluate(() => window.threadterm.request('runtime.snapshot', {}));
  await page.evaluate(([revision, id]) => window.threadterm.request('settings.update', { patch: { theme: 'dark', language: 'zh-CN' }, expectedRevision: revision, operationId: id }), [settings.revision, randomUUID()]);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('threadterm.v3.boot-appearance') || '{}').theme === 'dark', null, { timeout: 10000 });
  const saved = await page.evaluate(() => localStorage.getItem('threadterm.v3.boot-appearance'));
  assert.deepEqual(JSON.parse(saved), { theme: 'dark', locale: 'zh-CN' });
  check(`the app saves the appearance for the next launch: ${saved}`);
  await page.reload({ waitUntil: 'commit' });
  await recordTimeline();
  const first = await page.evaluate(() => { const splash = document.getElementById('boot-splash'); return splash && { theme: splash.dataset.theme, lang: splash.lang, bg: getComputedStyle(splash).backgroundColor }; });
  assert.ok(first, 'the launch screen is up after a relaunch');
  assert.equal(first.theme, 'dark'); assert.equal(first.lang, 'zh-CN');
  assert.equal(first.bg, 'rgb(38, 38, 36)', 'dark launch screen uses the app dark canvas');
  await at(450); await shot('06-float-warm-dark-zh.png');
  await at(1150); await shot('07-converge-warm-dark-zh.png');
  const warmLog = await waitForTimelineEnd('warm');
  const warm = assertHandOver(warmLog, 'warm runtime', 2300);
  const statuses = [...new Set(warmLog.entries.map(entry => entry.status).filter(Boolean))];
  assert.ok(!statuses.includes('正在连接本地运行时'), 'no runtime-wait message when nothing waited');
  assert.ok(warm.total <= 2900, `a warm start is not dragged out (${warm.total} ms from navigation)`);
  check(`warm relaunch (dark, Chinese from the first frame): app rendered at ${warm.ready} ms, launch screen gone at ${warm.total} ms; statuses ${statuses.join(' → ')}`);
  await delay(300); await shot('08-app-after-warm-dark.png');

  // 3. Reduced motion: a still composition that only fades once the app is ready.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload({ waitUntil: 'commit' });
  await recordTimeline();
  const still = await page.evaluate(() => { const splash = document.getElementById('boot-splash'); return splash && { motion: splash.dataset.motion, agents: [...splash.querySelectorAll('.bs-agent')].filter(node => getComputedStyle(node).visibility !== 'hidden').length, title: Number(getComputedStyle(splash.querySelector('.bs-wordmark')).opacity) }; });
  if (still) {
    assert.equal(still.motion, 'reduced'); assert.equal(still.agents, 0, 'no flying agents under reduced motion');
    assert.equal(still.title, 1, 'the still composition is complete from the first paint');
    check(`reduced motion: still composition (no agents, wordmark opacity ${still.title})`);
  } else note('reduced motion: the app was ready before the first probe, launch screen already gone');
  const reduced = assertHandOver(await waitForTimelineEnd('reduced'), 'reduced motion', 700);
  check(`reduced motion: handed over ${reduced.latency} ms after the app rendered (fade only)`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Floating and session windows open straight into their content: the pre-paint script drops the screen.
  for (const query of ['floating=1', 'sessionId=qa-none']) {
    const url = new URL(page.url()); url.search = query;
    await page.goto(url.href, { waitUntil: 'commit' });
    // The pre-paint script removes the screen while the document is still parsing; a meta-delivered CSP can move that
    // one parser task later, so assert on the parsed document rather than on the commit instant.
    await page.waitForFunction(() => document.readyState !== 'loading', null, { timeout: 20000 });
    const present = await page.evaluate(() => !!document.getElementById('boot-splash'));
    assert.equal(present, false, `no launch screen in a ?${query} window`);
  }
  check('floating and session windows never show the launch screen');
  await teardown();

  // 4. The runtime cannot start: the launch screen clears promptly for the error screen.
  console.log('missing runtime …');
  await launch('failed', join(scratch, 'missing-runtime.exe'));
  const failedLog = await waitForTimelineEnd('failed');
  const gone = failedLog.entries.find(entry => !entry.present);
  const unavailable = await page.locator('.content.main .state button.primary').count();
  assert.equal(unavailable, 1, 'the runtime-unavailable screen with Retry is shown');
  assert.ok(failedLog.entries.some(entry => entry.status === "Can't reach the local runtime"), 'the launch screen says the runtime could not be reached');
  check(`runtime cannot start: launch screen gone at ${gone.at} ms, error screen with Retry shown`);
  await shot('09-runtime-unavailable.png');
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(error);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  if (page) report.timeline = await timeline().catch(() => undefined);
} finally {
  await teardown();
  await releaseLock?.();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (!keep) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  console.log(report.passed && !report.errors.length ? 'BOOT SPLASH QA PASSED' : `BOOT SPLASH QA FAILED\n${report.errors.join('\n')}`);
  process.exit(report.passed && !report.errors.length ? 0 : 1);
}
