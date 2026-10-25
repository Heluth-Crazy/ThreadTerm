// Desktop-1 QA: session configuration follows the app language without saving or clearing unsaved fields.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const out = join(root, 'qa/results/session-config-locale');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app;
let page;

async function buildApp(appDir) {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'session-config-locale-qa', version: '0.1.0', main: 'main.cjs' }));
}

try {
  assert.ok(existsSync(runtime), `missing runtime ${runtime}`);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'tt-config-locale-'));
  const work = join(scratch, 'work');
  const appDir = join(out, 'app');
  await buildApp(appDir);
  const dropped = /^(path|home|userprofile|codex_home|data|profile|pipe|openai_api_key|threadterm_v3_data|threadterm_v3_user_data|threadterm_v3_pipe|threadterm_v3_runtime)$/iu;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !dropped.test(key)));
  Object.assign(env, {
    Path: [dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-config-locale-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
  });
  await mkdir(work, { recursive: true });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'PATH isolation keeps exactly one spelling');
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: scratch, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 60_000 });
  const rpc = (method, params = {}) => page.evaluate(([name, value]) => Promise.race([
    window.threadterm.request(name, value),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`RPC timeout: ${name}`)), 20000)),
  ]), [method, params]);
  const project = await rpc('project.add', { path: work, name: 'Config locale QA', operationId: randomUUID() });
  const session = await rpc('session.create', { projectId: project.id, cwd: work, provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/Q', '/K'], title: 'Config locale QA', operationId: randomUUID() });
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', workspacePath: work, operationId: randomUUID() });
  await page.getByRole('button', { name: 'Session details' }).click();
  await page.getByRole('button', { name: 'Configure' }).click();
  const dialog = page.getByRole('dialog', { name: 'Session configuration' });
  await dialog.waitFor();
  await dialog.getByText('Executable', { exact: true }).waitFor();
  await dialog.getByText('Automatic retry', { exact: true }).waitFor();
  const providerSelect = dialog.getByRole('combobox').nth(0);
  const modeSelect = dialog.getByRole('combobox').nth(1);
  await providerSelect.click();
  await page.getByRole('option', { name: 'Custom', exact: true }).click();
  await modeSelect.click();
  await page.getByRole('option', { name: 'Structured Chat', exact: true }).click();
  const draft = 'KEEP-THIS-ARG\n--provider-specific=nondefault';
  await dialog.locator('textarea').fill(draft);
  const snap = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: { language: 'zh-CN', theme: 'dark', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snap.settings.revision, operationId: randomUUID() });
  await page.setViewportSize({ width: 560, height: 760 });
  const chinese = page.getByRole('dialog', { name: '会话配置' });
  await chinese.waitFor();
  assert.equal(await chinese.locator('textarea').inputValue(), draft, 'locale change replaced unsaved arguments');
  assert.equal(await chinese.getByRole('combobox').nth(0).getAttribute('data-value'), 'custom', 'locale change replaced the selected provider');
  assert.equal(await chinese.getByRole('combobox').nth(1).getAttribute('data-value'), 'chat', 'locale change replaced the selected mode');
  await chinese.getByText('可执行文件', { exact: true }).waitFor();
  await chinese.getByText('自动重试', { exact: true }).waitFor();
  await chinese.getByPlaceholder('每行一个参数').waitFor();
  await page.screenshot({ path: join(out, 'config-zh-dark-narrow.png') });
  const snap2 = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: { language: 'en', theme: 'light' }, expectedRevision: snap2.settings.revision, operationId: randomUUID() });
  await page.setViewportSize({ width: 1100, height: 800 });
  const english = page.getByRole('dialog', { name: 'Session configuration' });
  await english.waitFor();
  assert.equal(await english.locator('textarea').inputValue(), draft, 'switching back to English replaced unsaved arguments');
  assert.equal(await english.getByRole('combobox').nth(0).getAttribute('data-value'), 'custom', 'English locale switch replaced the selected provider');
  assert.equal(await english.getByRole('combobox').nth(1).getAttribute('data-value'), 'chat', 'English locale switch replaced the selected mode');
  await page.screenshot({ path: join(out, 'config-en-light-wide.png') });
  await english.getByRole('button', { name: 'Cancel' }).click();
  await english.waitFor({ state: 'detached' });
  const saved = await rpc('session.config.read', { sessionId: session.id });
  assert.equal(saved.args.includes(draft), false, 'cancel saved the unsaved argument');
  report.screenshots.push(join(out, 'config-zh-dark-narrow.png'), join(out, 'config-en-light-wide.png'));
  report.checks.push('configuration labels follow locale; non-default provider/mode and provider-specific unsaved arguments survive both locale switches, while Cancel leaves saved config unchanged');
  report.passed = true;
  process.stdout.write('PASS session configuration locale\n');
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (!report.passed && page) await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => undefined);
  await mkdir(out, { recursive: true }).catch(() => undefined);
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
  if (app) {
    await Promise.race([
      page?.evaluate(id => window.threadterm?.request('runtime.shutdown', { operationId: id }), randomUUID()).catch(() => undefined),
      new Promise(resolveClose => setTimeout(resolveClose, 5000)),
    ]);
    await Promise.race([app.close().catch(() => undefined), new Promise(resolveClose => setTimeout(resolveClose, 5000))]);
  }
  process.stdout.write(`${report.passed ? 'SESSION CONFIG QA PASSED' : 'SESSION CONFIG QA FAILED'} ${join(out, 'report.json')}\n`);
  process.exit(report.passed ? 0 : 1);
}
