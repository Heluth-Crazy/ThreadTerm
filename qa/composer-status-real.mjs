// Desktop-1 production-path QA for C3. A fake Codex app-server emits one
// native token-usage update after a turn; this verifies runtime projection,
// persisted chat.context reads, and the production composer controls.
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
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/fake-codex-status.cjs');
const out = join(root, 'qa/results/chat-parity/C3/composer-status-real');
const scratch = await mkdtemp(join(tmpdir(), 'tt-composer-status-'));
const appDir = join(scratch, 'app');
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const log = join(scratch, 'codex-status-requests.jsonl');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app; let page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() <= end) {
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await delay(150);
  }
  throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
}
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'composer-status-qa', version: '0.1.0', main: 'main.cjs' }));
}

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(fixture), `missing ${fixture}`);
  await rm(out, { recursive: true, force: true });
  await Promise.all([mkdir(out, { recursive: true }), mkdir(bin, { recursive: true }), mkdir(workspace, { recursive: true }), writeFile(log, '')]);
  await buildApp();
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nnode ${JSON.stringify(fixture)}\r\n`);
  const gitPaths = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).filter(Boolean);
  const gitExe = gitPaths.find(value => /\\cmd\\git\.exe$/i.test(value)) ?? gitPaths[0];
  assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [bin, dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    CODEX_HOME: join(scratch, 'codex-home'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-composer-status-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_QA_CODEX_STATUS_LOG: log, THREADTERM_QA_CODEX_STATUS_CWD: workspace,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');
  await mkdir(env.CODEX_HOME, { recursive: true });
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') report.errors.push(`console: ${message.text()}`);
    if (message.text().includes('[threadterm] 浏览器演示模式')) report.errors.push('the development mock bridge activated in the production app');
  });
  await page.waitForFunction(() => Boolean(window.threadterm));
  assert.notEqual(await page.evaluate(() => window.threadterm.platform), 'browser', 'the production app must use its preload bridge, not the browser demo mock');
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await page.evaluate(() => {
    let value = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { value = String(text); }, readText: async () => value } });
    window.__qaClipboard = { get: () => value };
  });
  const initial = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  const project = await request('project.add', { path: workspace, name: 'Composer status QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: workspace, title: 'Composer status QA', provider: 'codex', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const scope = page.locator(`[data-testid="session-chat-${chat.id}"]`);
  // ChatView owns the lease and connect. The textarea stays disabled (and the
  // form is inert) until the overlay clears, so wait like chat-plan-real before
  // any chat.* RPC. chat.send before that returns chat_not_open.
  await until(() => scope.locator('.chat-compose-shell textarea').isEnabled(), 'chat composer ready');
  await until(async () => (await request('chat.connection', { sessionId: chat.id })).phase === 'ready', 'chat connection ready');
  await scope.locator('.chat-compose-shell textarea').fill('Emit the QA status.');
  await scope.locator('.chat-compose-send[type=submit]').click();
  const usage = await until(async () => {
    const snapshot = await request('chat.context.read', { sessionId: chat.id });
    if (snapshot?.usedTokens === 94700 && snapshot?.windowTokens === 258000) return snapshot;
  }, 'persisted context projection');
  assert.ok(Math.abs(usage.percent - 36.705) < 0.01, `runtime percent is 94700/258000, got ${usage.percent}`);
  await scope.locator('.chat-context-ring').waitFor();
  assert.equal((await scope.locator('.chat-context-percent').textContent()).trim(), '37%');
  const composerSelector = `[data-testid="session-chat-${chat.id}"] .chat-compose-shell`;
  const menuSelector = `[data-testid="session-chat-${chat.id}"] .chat-status-menu`;
  // The visual helper focuses controls. Do that on the closed composer first;
  // focusing a composer chip while a status popover is open dismisses it.
  assertNoControlViolations(await checkControlConsistency(page, composerSelector), 'real-app context composer');
  await scope.locator('[data-status-trigger="context"]').click();
  await scope.locator('.chat-status-menu').waitFor();
  assert.match(await scope.locator('.chat-status-menu').innerText(), /94,700 \/ 258,000/);
  assert.match(await scope.locator('.chat-status-menu').innerText(), /Cache hit rate/);
  assertNoControlViolations(await checkControlConsistency(page, menuSelector), 'real-app context popover');
  await page.screenshot({ path: join(out, 'codex-status-context-light-en.png'), animations: 'disabled' });
  report.screenshots.push('codex-status-context-light-en.png');
  await page.keyboard.press('Escape');
  await scope.locator('.chat-status-menu').waitFor({ state: 'detached' });
  await scope.locator('[data-status-trigger="connection"]').click();
  await scope.locator('.chat-status-menu').waitFor();
  assert.match(await scope.locator('.chat-status-menu').innerText(), /qa-codex-status-thread/);
  assert.match(await scope.locator('.chat-status-menu').innerText(), /Codex/);
  const sessionCopy = scope.locator('.chat-status-copy').nth(1);
  assert.equal(await sessionCopy.getAttribute('aria-label'), 'Copy Provider session');
  await sessionCopy.click();
  await page.waitForFunction(() => [...document.querySelectorAll('.chat-status-copy')].some(button => button.textContent?.trim() === 'Copied'));
  assert.equal(await page.evaluate(() => window.__qaClipboard.get()), 'qa-codex-status-thread');
  assertNoControlViolations(await checkControlConsistency(page, menuSelector), 'real-app connection popover');
  await page.screenshot({ path: join(out, 'codex-status-connection-light-en.png'), animations: 'disabled' });
  report.screenshots.push('codex-status-connection-light-en.png');
  check('fake Codex turn projects persisted context usage into the production ring and popover');
  check('production connection chip exposes the fake provider session identity');
  const calls = (await readFile(log, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.ok(calls.some(call => call.method === 'turn/start'), 'the fixture received the test turn');
  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (existsSync(log)) await writeFile(join(out, 'codex-requests.jsonl'), await readFile(log));
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed ? 'COMPOSER STATUS REAL-APP QA PASSED' : `COMPOSER STATUS REAL-APP QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
