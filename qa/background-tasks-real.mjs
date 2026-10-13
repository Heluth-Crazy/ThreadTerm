// Desktop 1: real app/runtime, fake native server, isolated profile/PATH.
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

const root = resolve(import.meta.dirname, '..'), scratch = await mkdtemp(join(tmpdir(), 'tt-background-real-'));
const out = join(root, 'qa/results/chat-parity/F6/background-tasks-real', new Date().toISOString().replace(/[:.]/g, '-'));
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const bin = join(scratch, 'bin'), appDir = join(scratch, 'app'), work = join(scratch, 'work'), log = join(scratch, 'native.jsonl');
let app, page, session;
process.env.TT_QA_DESKTOP = '1';
const report = { passed: false, checks: [], screenshots: [], errors: [] };
const rpc = (method, params = {}) => page.evaluate(([m, p]) => window.threadterm.request(m, p), [method, params]);
const nativeCalls = async () => (await readFile(log, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const chat = () => page.locator(`[data-testid="session-chat-${session.id}"]`);
const strip = () => chat().getByTestId('background-tasks-strip');
async function until(probe, label) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) { if (await probe()) return; await new Promise(done => setTimeout(done, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function settings(language, theme) {
  const current = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: {
    language, theme: theme === 'custom' ? 'light' : theme, themeSelection: theme === 'custom' ? 'custom:qa' : theme,
    ...(theme === 'custom' ? { customThemes: { qa: { background: '#e8eef4', surface: '#f7fbff', text: '#142f42', muted: '#4b6477', accent: '#b65912', border: '#a6b6c5' } } } : {}),
    notifications: { native: false, attention: false, completed: false, sound: false },
  }, expectedRevision: current.settings.revision, operationId: randomUUID() });
}
async function shot(name) { await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
try {
  assert.ok(existsSync(runtime), `Build ${runtime} before this check`);
  await Promise.all([mkdir(bin), mkdir(appDir), mkdir(work), mkdir(out, { recursive: true })]); await writeFile(log, '');
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean); assert.ok(gitExe);
  for (const args of [['init', '-q'], ['config', 'user.name', 'QA'], ['config', 'user.email', 'qa@example.invalid']]) {
    const result = spawnSync(gitExe, args, { cwd: work, encoding: 'utf8', windowsHide: true, timeout: 30_000 }); assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(join(bin, 'shim.rs'), 'fn main(){let s=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(s.code().unwrap_or(1));}');
  const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }); assert.equal(compiled.status, 0, compiled.stderr);
  for (const name of ['main', 'preload']) await build({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`) });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), '{"name":"f6-qa","version":"1.0.0","main":"main.cjs"}');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, { Path: [bin, dirname(gitExe), dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\f6-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime, CODEX_HOME: join(scratch, 'home'), TT_QA_NODE: process.execPath,
    TT_QA_SCRIPT: join(root, 'qa/fixtures/fake-codex-background-tasks.cjs'), THREADTERM_QA_BACKGROUND_CWD: work, THREADTERM_QA_BACKGROUND_LOG: log,
  });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path']);
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(30_000); page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('#boot-splash').waitFor({ state: 'detached' }); await settings('en', 'light');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const project = await rpc('project.add', { path: work, name: 'F6', operationId: randomUUID() });
  session = await rpc('session.create', { projectId: project.id, cwd: work, provider: 'codex', mode: 'chat', title: 'F6', operationId: randomUUID() });
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(async () => (await rpc('chat.connection', { sessionId: session.id })).phase === 'ready', 'fake Codex ready');
  assert.equal(await strip().count(), 0, 'empty Chat has no strip'); await shot('empty-light-en-wide.png');
  assert.equal((await nativeCalls()).filter(call => call.method === 'thread/backgroundTerminals/list').length, 0, 'no startup list probe');
  await chat().locator('textarea').fill('start synthetic background tasks'); await chat().locator('.chat-compose-send[type=submit]').click();
  await strip().waitFor(); await until(async () => (await rpc('chat.options', { sessionId: session.id })).backgroundTasks?.length === 2, 'two candidates survive parent turn');
  assert.match(await strip().innerText(), /2 background tasks/);
  assert.equal((await nativeCalls()).filter(call => call.method === 'thread/backgroundTerminals/list').length, 0, 'collapsed tasks make no native list call');
  for (const theme of ['light', 'dark', 'custom']) for (const language of ['en', 'zh-CN']) for (const width of [1440, 420]) {
    await settings(language, theme); await page.setViewportSize({ width, height: 900 });
    const toggle = strip().getByRole('button', { name: /background tasks|后台任务/ });
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
    for (const expanded of [false, true]) {
      if (expanded) { await toggle.click(); await strip().locator('.chat-background-row').first().waitFor(); await until(async () => await strip().getByRole('status').count() === 0, 'list read settled'); }
      assert.ok(await strip().evaluate(node => node.scrollWidth <= node.clientWidth), 'strip fits the pane');
      assertNoControlViolations(await checkControlConsistency(page, '.chat-background-tasks'), `${theme}/${language}/${width}/${expanded}`);
      await shot(`running-${theme}-${language}-${width}-${expanded ? 'expanded' : 'collapsed'}.png`);
    }
  }
  assert.equal(await strip().locator('.chat-background-row').count(), 2, 'paged list returns both tasks');
  assert.equal(await strip().locator('[data-task-id="foreground"]').count(), 0, 'ordinary completed command excluded');
  const rows = strip().locator('.chat-background-row');
  await rows.first().getByRole('button', { name: /Output|输出/ }).click();
  await until(async () => await chat().locator('.chat-tool-activity[open]').count() > 0, 'Output opens the actual tool card');
  for (const width of [1440, 420]) {
    await page.setViewportSize({ width, height: 900 });
    const overlay = chat().locator('.chat-back-to-bottom'); await overlay.waitFor();
    const obstruction = await chat().evaluate(root => {
      const button = root.querySelector('.chat-back-to-bottom').getBoundingClientRect();
      const viewport = root.querySelector('.v3-chat-log').getBoundingClientRect();
      const hit = rect => rect.width > 0 && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
        && rect.left < button.right && rect.right > button.left && rect.top < button.bottom && rect.bottom > button.top;
      return [...root.querySelectorAll('.chat-tool-entry-label, .chat-part.approval strong, .chat-question-title, .v3-chat-log button, .v3-chat-log input, .v3-chat-log textarea')].filter(node => hit(node.getBoundingClientRect())).map(node => node.className || node.tagName);
    });
    assert.deepEqual(obstruction, [], `${width}: compact back-to-bottom does not cover titles/actions/inputs`);
    assert.equal(await overlay.locator('kbd, span:not(.ico)').count(), 0, 'Esc hint belongs to tooltip only');
    await shot(`output-overlay-${width}.png`);
  }
  const target = await rows.first().getAttribute('data-task-id');
  const stop = rows.first().getByRole('button', { name: /Stop task|停止任务/ });
  await stop.click();
  await until(async () => (await rpc('chat.options', { sessionId: session.id })).backgroundTasks.some(task => task.id === target && task.status === 'stopped'), 'native termination reflected');
  const calls = (await nativeCalls()).filter(call => call.method === 'thread/backgroundTerminals/terminate');
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].params, { threadId: 'qa-background-thread', processId: target });
  assert.equal(await rows.first().getByRole('button', { name: /Stop task|停止任务/ }).count(), 0, 'finished row has no Stop');
  await shot('stopped-retained.png');
  await until(async () => (await rpc('runtime.snapshot')).sessions.find(row => row.id === session.id)?.status === 'idle', 'idle parent');
  await chat().locator('textarea').fill('next turn'); await chat().locator('.chat-compose-send[type=submit]').click();
  await until(async () => (await rpc('chat.options', { sessionId: session.id })).backgroundTasks.length === 1, 'next turn drops terminal task and preserves live work');
  await shot('next-turn-running-survives.png');
  assert.deepEqual(report.errors, []); report.checks.push('No startup/collapsed RPC, page aggregation, foreground exclusion, 12-cell running matrix, Output opens actual tool, exact native Stop, terminal retention then next-turn pruning'); report.passed = true;
} catch (error) { report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
