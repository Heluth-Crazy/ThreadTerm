// Desktop-1 QA: a floating viewer shows its own titlebar and close destroys only that window.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? join(root, 'runtime/target/debug/threadterm-v3-runtime.exe'));
const out = join(root, 'qa/results/floating-close');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app;
let page;

async function buildApp(appDir) {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'floating-close-qa', version: '0.1.0', main: 'main.cjs' }));
}

try {
  assert.ok(existsSync(runtime), `missing runtime ${runtime}`);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'tt-floating-close-'));
  const bin = join(scratch, 'bin');
  const fixture = join(root, 'qa/fixtures/fake-codex-reconnect.cjs');
  const control = join(scratch, 'control');
  const nativeLog = join(scratch, 'fake-codex.jsonl');
  const appDir = join(out, 'app');
  await buildApp(appDir);
  const dropped = /^(path|home|userprofile|codex_home|data|profile|pipe|openai_api_key|threadterm_v3_data|threadterm_v3_user_data|threadterm_v3_pipe|threadterm_v3_runtime)$/iu;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !dropped.test(key)));
  Object.assign(env, {
    Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-floating-close-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    CODEX_HOME: join(scratch, 'codex-home'), TT_QA_NODE: process.execPath, TT_QA_SCRIPT: fixture, THREADTERM_QA_CODEX_RECONNECT_LOG: nativeLog, THREADTERM_QA_CODEX_RECONNECT_CWD: join(scratch, 'work'), THREADTERM_QA_CODEX_RECONNECT_CONTROL: control,
  });
  await Promise.all([bin, control, join(scratch, 'data'), join(scratch, 'codex-home')].map(path => mkdir(path, { recursive: true })));
  assert.ok(existsSync(fixture), `missing fake Codex fixture ${fixture}`);
  await writeFile(join(bin, 'shim.rs'), 'fn main(){let s=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(s.code().unwrap_or(1));}');
  const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding:'utf8', windowsHide:true });
  assert.equal(compiled.status, 0, compiled.stderr);
  await mkdir(join(scratch, 'work'), { recursive: true });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'PATH isolation keeps exactly one spelling');
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: scratch, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(30_000);
  const step = (label) => process.stdout.write(`STEP ${label}\n`);
  step('window');
  await page.waitForFunction(() => Boolean(window.threadterm));
  step('bridge');
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 60_000 });
  step('ready');
  const rpc = (method, params = {}) => page.evaluate(([name, value]) => Promise.race([
    window.threadterm.request(name, value),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`RPC timeout: ${name}`)), 20000)),
  ]), [method, params]);
  step('project');
  const project = await rpc('project.add', { path: join(scratch, 'work'), name: 'Floating close QA', operationId: randomUUID() });
  step('session');
  const session = await rpc('session.create', { projectId: project.id, cwd: join(scratch, 'work'), provider: 'codex', mode: 'chat', title: 'Floating close QA', operationId: randomUUID() });
  step('present');
  await rpc('session.present', { sessionId: session.id, placement: 'window', presentation: 'background', workspacePath: join(scratch, 'work'), operationId: randomUUID() });
  step('float');
  let floatPage;
  let seen = [];
  for (let attempt = 0; attempt < 80 && !floatPage; attempt += 1) {
    const windows = app.windows();
    seen = windows.map(item => { try { return item.url(); } catch { return 'unavailable'; } });
    floatPage = windows.find(item => { try { return item.url().includes('floating=1'); } catch { return false; } });
    if (!floatPage) await page.waitForTimeout(250);
  }
  assert.ok(floatPage, `floating window did not open (${seen.length}): ${seen.join(' | ')}`);
  floatPage.setDefaultTimeout(20_000);
  await floatPage.locator('#boot-splash').waitFor({ state: 'detached' }).catch(() => undefined);
  await floatPage.locator('.floating-shell > .titlebar').waitFor();
  const composer = floatPage.locator(`[data-testid="session-chat-${session.id}"] textarea`);
  await composer.waitFor();
  await composer.fill('dirty floating draft survives close');
  await floatPage.waitForTimeout(700); // Let the production debounced durable draft writer settle before close.
  const geometry = await floatPage.locator('.floating-shell').evaluate(node => getComputedStyle(node).gridTemplateRows);
  assert.match(geometry, /36px/, `floating header row is missing: ${geometry}`);
  for (const [language, theme, width, label, closeName] of [['en', 'light', 1100, 'wide', 'Close window'], ['zh-CN', 'dark', 560, 'narrow', '关闭窗口']]) {
    const snap = await rpc('runtime.snapshot');
    await rpc('settings.update', { patch: { language, theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snap.settings.revision, operationId: randomUUID() });
    await floatPage.setViewportSize({ width, height: 720 });
    const close = floatPage.getByRole('button', { name: closeName });
    await close.waitFor();
    const box = await close.boundingBox();
    assert.ok(box && box.y < 40 && box.height > 0, `${label}: close control is outside the 36px titlebar`);
    await floatPage.screenshot({ path: join(out, `float-${language}-${theme}-${label}.png`) });
    report.screenshots.push(join(out, `float-${language}-${theme}-${label}.png`));
  }
  const before = app.windows().length;
  await floatPage.getByRole('button', { name: '关闭窗口' }).click();
  for (let attempt = 0; attempt < 40 && app.windows().some(item => item.url().includes('floating=1')); attempt += 1) await page.waitForTimeout(150);
  assert.equal(app.windows().some(item => item.url().includes('floating=1')), false, 'floating window stayed open');
  assert.ok(app.windows().includes(page), 'closing the float also closed the main window');
  assert.ok(before >= 2, 'the float was never a separate window');
  const after = await rpc('runtime.snapshot');
  const kept = after.sessions.find(item => item.id === session.id);
  assert.ok(kept, 'closing the floating viewer deleted the session');
  assert.notEqual(kept.status, 'exited', 'closing the floating viewer stopped the fake native provider session');
  await rpc('session.present', { sessionId: session.id, placement: 'window', presentation: 'background', workspacePath: join(scratch, 'work'), operationId: randomUUID() });
  floatPage = undefined;
  for (let attempt = 0; attempt < 40 && !floatPage; attempt += 1) { floatPage = app.windows().find(item => { try { return item.url().includes('floating=1'); } catch { return false; } }); if (!floatPage) await page.waitForTimeout(150); }
  assert.ok(floatPage, 'fast reopen did not create a floating viewer');
  const restored = floatPage.locator(`[data-testid="session-chat-${session.id}"] textarea`);
  await restored.waitFor();
  const recovered = await restored.inputValue();
  assert.equal(recovered, 'dirty floating draft survives close', 'fast close/reopen lost the dirty Chat draft');
  report.checks.push('floating titlebar closes only its window; fake native provider session and dirty Chat draft survive fast close/reopen');
  report.passed = true;
  process.stdout.write('PASS floating window closes independently\n');
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (!report.passed && page) {
    report.errors.push(await page.locator('.bs-status-text').innerText().catch(() => 'splash status unavailable'));
    await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => undefined);
  }
  await mkdir(out, { recursive: true }).catch(() => undefined);
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
  if (app) {
    await Promise.race([
      page?.evaluate(id => window.threadterm?.request('runtime.shutdown', { operationId: id }), randomUUID()).catch(() => undefined),
      new Promise(resolveClose => setTimeout(resolveClose, 5000)),
    ]);
    await Promise.race([app.close().catch(() => undefined), new Promise(resolveClose => setTimeout(resolveClose, 5000))]);
  }
  process.stdout.write(`${report.passed ? 'FLOATING CLOSE QA PASSED' : 'FLOATING CLOSE QA FAILED'} ${join(out, 'report.json')}\n`);
  process.exit(report.passed ? 0 : 1);
}
