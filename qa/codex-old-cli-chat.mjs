// Desktop-1 real-app acceptance QA for the portability path: a Codex Chat on an
// older app-server (no thread/inject_items, thread/read without turns) must
// connect, show one non-blocking notice, and run a turn instead of failing.
// It builds and starts the production app on an isolated profile/data/pipe with
// a fake app-server; it never starts a real agent CLI and never touches the
// user's profile or clipboard.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN || join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/fake-codex-old-cli.cjs');
const out = join(root, 'qa/results/chat-parity/B5/old-cli');
const scratch = await mkdtemp(join(tmpdir(), 'tt-codex-old-cli-'));
const appDir = join(scratch, 'app');
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const log = join(scratch, 'codex-requests.jsonl');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app; let page; let releaseLock;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const requests = async () => (await readFile(log, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const composer = id => page.locator(`[data-testid="session-chat-${id}"] .chat-compose-shell textarea`);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(150); } }
async function shot(name) { await delay(200); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function buildApp() { await mkdir(appDir, { recursive: true }); for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' }); await viteBuild({ ...(process.env.THREADTERM_QA_RENDERER_ROOT ? { root: resolve(process.env.THREADTERM_QA_RENDERER_ROOT) } : {}), configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } }); await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'codex-old-cli-qa', version: '0.1.0', main: 'main.cjs' })); }

try {
  releaseLock = await acquireElectronQaLock();
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(fixture), 'missing fake Codex old-CLI fixture');
  await mkdir(out, { recursive: true }); await mkdir(bin, { recursive: true }); await mkdir(workspace, { recursive: true }); await writeFile(log, '');
  await buildApp();
  // Fake Codex: a cmd shim runs the fixture regardless of the `-c` overrides the
  // runtime puts before the `app-server` argument.
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nnode ${JSON.stringify(fixture)}\r\n`);
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(value => /\\cmd\\git\.exe$/i.test(value)) || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean); assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [bin, dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    CODEX_HOME: join(scratch, 'codex-home'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-codex-old-cli-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_QA_CODEX_OLD_CLI_LOG: log,
    THREADTERM_QA_CODEX_OLD_CLI_CWD: workspace,
    THREADTERM_QA_CODEX_OLD_CLI_IMAGE: 'http://127.0.0.1:1/qa-image.png',
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');
  await mkdir(env.CODEX_HOME, { recursive: true });
  app = await electron.launch({ args: [appDir, '--disable-features=CalculateNativeWinOcclusion', '--force-device-scale-factor=1'], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const initial = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });

  const project = await request('project.add', { path: workspace, name: 'Codex old CLI QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: workspace, title: 'Codex old CLI QA', provider: 'codex', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  try { await until(() => composer(chat.id).isEnabled(), 'chat composer ready'); }
  catch (error) {
    const link = await request('chat.connection', { sessionId: chat.id }).catch(() => undefined);
    throw new Error(`${error.message}${link ? ` (${link.phase}${link.error ? `: ${link.error.code} ${link.error.message}` : ''})` : ''}`);
  }
  const scope = page.locator(`[data-testid="session-chat-${chat.id}"]`);
  const connected = await request('chat.connection', { sessionId: chat.id });
  assert.equal(connected.phase, 'ready', `the Chat is connected (${connected.phase})`);
  assert.ok(connected.nativeId, 'the Chat has a native identity');
  check('an older app-server connects a Codex Chat instead of failing the connect');

  // One non-blocking notice, from the same reading as Settings -> Tools.
  const options = await request('chat.options', { sessionId: chat.id });
  assert.equal(options.notice?.code, 'codex_cli_limited');
  assert.equal(options.notice?.version, '0.159.1');
  assert.equal(options.notice?.feature, 'thread/inject_items');
  const banner = scope.locator('.chat-repair-notice');
  await banner.waitFor({ timeout: 20_000 });
  const bannerText = await banner.innerText();
  assert.match(bannerText, /a new chat is saved only after its first message/);
  assert.doesNotMatch(bannerText, /thread\//);
  assert.match(bannerText, /Update Codex/);
  assert.doesNotMatch(bannerText, /[\u3400-\u9fff]/, 'an English window shows only the English sentence');
  assert.equal(await composer(chat.id).isEnabled(), true, 'the notice never blocks the composer');
  check('one non-blocking notice names the CLI version and what to update');

  // The turn still runs on the same native thread.
  await composer(chat.id).fill('Hello from an older CLI.');
  await scope.locator('.chat-compose-send[type=submit]').click();
  await until(async () => (await request('chat.read', { sessionId: chat.id })).some(item => item.role === 'assistant' && item.parts.some(part => /The old CLI answered/.test(part.text ?? ''))), 'assistant answer');
  await until(async () => (await request('runtime.snapshot')).sessions.find(item => item.id === chat.id)?.status === 'idle', 'turn completion');
  const calls = await requests();
  assert.ok(calls.some(row => row.method === 'turn/start'), 'the turn reached the native app-server');
  assert.equal(calls.filter(row => row.method === 'thread/inject_items').length, 1, 'the missing method is probed once');
  assert.ok(calls.every(row => row.method !== 'thread/read'), 'nothing tries to verify a thread that cannot be materialized');
  check('the degraded Chat runs a turn and never retries the missing method');

  for (const language of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) {
    const snapshot = await request('runtime.snapshot');
    await request('settings.update', { patch: { language, theme, themeSelection: theme }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    const zh = language === 'zh-CN';
    await until(async () => zh === /当前 Codex CLI/.test(await banner.innerText()), 'translated notice');
    assert.doesNotMatch(await banner.innerText(), zh ? /Update Codex/ : /[\u3400-\u9fff]/);
    const imageLoad = scope.locator('.md-remote-image-load');
    await until(async () => await imageLoad.innerText() === (zh ? '载入图片' : 'Load image'), 'live Chat remote-image action locale');
    assert.equal(await scope.locator('img[src^="http:"]').count(), 0, 'the remote image stays inert until explicitly loaded');
    await scope.evaluate(element => { element.style.width = ''; element.style.maxWidth = ''; element.style.minWidth = ''; });
    await shot(`old-cli-${theme}-1440-${language}.png`);
    // Narrow the actual chat surface, rather than asking Electron to violate its window minimum.
    await scope.evaluate(element => { element.style.width = '420px'; element.style.maxWidth = '420px'; element.style.minWidth = '0'; });
    const paneWidth = await scope.evaluate(element => element.getBoundingClientRect().width);
    assert.ok(Math.abs(paneWidth - 420) <= 1, `the chat pane is really 420 px (${paneWidth})`);
    const overflow = await scope.locator('.chat-log-shell').evaluate(element => element.scrollWidth - element.clientWidth);
    assert.ok(overflow <= 1, `the notice does not overflow a real 420 px pane (${overflow})`);
    const name = `old-cli-${theme}-pane-420-${language}.png`;
    await scope.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name);
    check(`${language} ${theme}: notice fits a measured 420 px chat pane`);
  }
  await banner.getByRole('button', { name: '关闭', exact: true }).click();
  await until(async () => await banner.count() === 0, 'notice dismissed');
  const optionsAfterDismiss = await request('chat.options', { sessionId: chat.id });
  assert.equal(optionsAfterDismiss.notice.feature, options.notice.feature, 'dismissal does not change provider diagnostics');
  await page.reload();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(() => composer(chat.id).isEnabled(), 'chat ready after reload');
  await until(async () => (await request('chat.options', { sessionId: chat.id })).notice?.feature === options.notice.feature, 'notice restored by runtime');
  assert.equal(await page.locator('.chat-provider-notice').count(), 0, 'dismissal survives Chat remount and reload');
  check('CLI notice dismissal survives remount while diagnostics remain available');

  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (existsSync(log)) await writeFile(join(out, 'codex-requests.jsonl'), await readFile(log)).catch(() => {});
  if (existsSync(join(scratch, 'data/runtime.log'))) await writeFile(join(out, 'runtime.log'), await readFile(join(scratch, 'data/runtime.log'))).catch(() => {});
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  if (releaseLock) await releaseLock();
  console.log(report.passed ? 'CODEX OLD-CLI QA PASSED' : `CODEX OLD-CLI QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
