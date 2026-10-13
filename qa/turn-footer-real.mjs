// Desktop 1 only. Production renderer/runtime, isolated profile and fake Codex.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const scratch = await mkdtemp(join(tmpdir(), 'tt-turn-footer-'));
const out = join(root, 'qa/results/chat-parity/F1/turn-footer-real', new Date().toISOString().replace(/[:.]/g, '-'));
const bin = join(scratch, 'bin'), work = join(scratch, 'work'), appDir = join(scratch, 'app');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app, page, session;
process.env.TT_QA_DESKTOP = '1';
const rpc = (method, params = {}) => page.evaluate(([m, p]) => window.threadterm.request(m, p), [method, params]);
const audit = () => page.evaluate(() => window.threadtermQaAudit.calls());
const chat = () => page.locator(`[data-testid="session-chat-${session.id}"]`);
async function until(probe, label) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) { if (await probe()) return; await new Promise(done => setTimeout(done, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function shot(name) { await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function settings(language, theme) {
  const current = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: {
    language, theme: theme === 'custom' ? 'light' : theme, themeSelection: theme === 'custom' ? 'custom:qa' : theme,
    ...(theme === 'custom' ? { customThemes: { qa: { background: '#e8eef4', surface: '#f7fbff', text: '#142f42', muted: '#4b6477', accent: '#b65912', border: '#a6b6c5' } } } : {}),
    notifications: { native: false, attention: false, completed: false, sound: false },
  }, expectedRevision: current.settings.revision, operationId: randomUUID() });
}
async function buildApp() {
  await mkdir(appDir);
  await build({ entryPoints: [join(root, 'desktop/src/main.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(appDir, 'main.cjs') });
  // Audit actual IPC requests in this QA preload; contextBridge APIs are frozen.
  const original = await readFile(join(root, 'desktop/src/preload.ts'), 'utf8');
  const expression = "ipcRenderer.invoke('threadterm:request', method, params) as Promise<RequestResult<M>>";
  assert.equal(original.split(expression).length, 2, 'exact production request instrumentation point');
  const preload = original.replace(expression, `(((globalThis as any).__f1 ??= []).push({method,params}), ${expression})`)
    + "\ncontextBridge.exposeInMainWorld('threadtermQaAudit', {calls: () => [...((globalThis as any).__f1 ?? [])]});\n";
  await build({ stdin: { contents: preload, resolveDir: join(root, 'desktop/src'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(appDir, 'preload.cjs') });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), '{"name":"f1-qa","version":"1.0.0","main":"main.cjs"}');
}
try {
  assert.ok(existsSync(runtime), `Build ${runtime} before running QA`);
  await Promise.all([mkdir(bin), mkdir(join(work, 'src/new'), { recursive: true }), mkdir(out, { recursive: true })]);
  await writeFile(join(work, 'src/edited.ts'), 'old\n');
  await writeFile(join(work, 'src/deleted.ts'), 'gone\n');
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean);
  assert.ok(gitExe);
  for (const args of [['init', '-q'], ['config', 'user.email', 'qa@example.invalid'], ['config', 'user.name', 'QA'], ['add', '.'], ['commit', '-qm', 'base']]) {
    const result = spawnSync(gitExe, args, { cwd: work, encoding: 'utf8', windowsHide: true, timeout: 30_000 }); assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(join(bin, 'shim.rs'), 'fn main(){let s=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(s.code().unwrap_or(1));}');
  const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }); assert.equal(compiled.status, 0, compiled.stderr);
  await buildApp();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, { Path: [bin, dirname(gitExe), dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\f1-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime, CODEX_HOME: join(scratch, 'home'), TT_QA_NODE: process.execPath,
    TT_QA_SCRIPT: join(root, 'qa/fixtures/fake-codex-turn-footer.cjs'), THREADTERM_QA_TURN_FOOTER_CWD: work, THREADTERM_QA_TURN_FOOTER_LOG: join(scratch, 'log'),
  });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path']);
  await writeFile(env.THREADTERM_QA_TURN_FOOTER_LOG, '');
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadtermQaAudit));
  await page.locator('#boot-splash').waitFor({ state: 'detached' }); await settings('en', 'light');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const project = await rpc('project.add', { path: work, name: 'F1', operationId: randomUUID() });
  session = await rpc('session.create', { projectId: project.id, cwd: work, provider: 'codex', mode: 'chat', title: 'F1', operationId: randomUUID() });
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(async () => (await rpc('chat.connection', { sessionId: session.id })).phase === 'ready', 'fake Codex ready');
  const input = chat().locator('textarea'); await input.waitFor();
  assert.equal(await chat().getByTestId('chat-turn-footer').count(), 0, 'empty chat has no footer'); await shot('empty-light-en-wide.png');
  await input.fill('slow edit'); await chat().locator('.chat-compose-send[type=submit]').click();
  await until(async () => (await rpc('runtime.snapshot')).sessions.find(row => row.id === session.id)?.status === 'running', 'running');
  assert.equal(await chat().getByRole('button', { name: /Files changed/ }).count(), 0, 'running turn has no completed review'); await shot('running-light-en-wide.png');
  const footer = chat().getByTestId('chat-turn-footer');
  await until(async () => (await rpc('chat.read', { sessionId: session.id })).some(item => item.turnReview?.fileCount === 3), 'frozen review metadata');
  await footer.waitFor();
  assert.match(await footer.locator('.chat-turn-meta').getAttribute('aria-label'), /Worked for .*qa-turn-footer-model.*12\.3k in.*2\.1k out.*40k cache/, 'frozen model and per-turn usage');
  assert.equal((await audit()).filter(call => call.method === 'review.changes').length, 0, 'no changes RPC before expansion');
  for (const theme of ['light', 'dark', 'custom']) for (const language of ['en', 'zh-CN']) for (const width of [1440, 420]) {
    await settings(language, theme); await page.setViewportSize({ width, height: 900 });
    const toggle = footer.getByRole('button', { name: /Files changed|更改文件/ });
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
    for (const expanded of [false, true]) {
      if (expanded) { await toggle.click(); await footer.locator('.chat-turn-file').first().waitFor(); }
      assert.ok(await footer.evaluate(node => node.scrollWidth <= node.clientWidth), 'footer does not clip');
      assert.ok(await footer.locator('.chat-turn-meta').evaluate(node => node.scrollWidth <= node.clientWidth), 'one-line metadata');
      assertNoControlViolations(await checkControlConsistency(page, '.chat-turn-footer'), `${theme}/${language}/${width}/${expanded}`);
      await shot(`done-${theme}-${language}-${width}-${expanded ? 'expanded' : 'collapsed'}.png`);
    }
  }
  const calls = (await audit()).filter(call => call.method === 'review.changes'); assert.equal(calls.length, 1, 'reopen uses cached turn');
  const metadata = (await rpc('chat.read', { sessionId: session.id })).find(item => item.turnReview)?.turnReview;
  assert.deepEqual(calls[0].params, { sessionId: session.id, from: metadata.from, to: metadata.to });
  const rows = await footer.locator('.chat-turn-file').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.querySelector('.chat-turn-file-heading > span').textContent, node.querySelector('.chat-turn-file-counts').textContent])));
  assert.deepEqual(rows, { 'src/edited.ts': '+1 −1', 'src/new/added.ts': '+1 −0', 'src/deleted.ts': '+0 −1' });
  await footer.getByRole('button', { name: /Open diff|查看差异/ }).first().click(); await page.getByTestId('review-diff-surface').waitFor();
  const diffs = (await audit()).filter(call => call.method === 'review.diff'); assert.equal(diffs.length, 1);
  assert.equal(diffs[0].params.from, metadata.from); assert.equal(diffs[0].params.to, metadata.to);
  assert.deepEqual(report.errors, []); report.checks.push('Three real files, frozen checkpoint pair/model/tokens, lazy cached RPCs, empty/running and 12-cell completed matrix with zero control violations'); report.passed = true;
} catch (error) { report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
