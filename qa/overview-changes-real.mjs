// Real-app QA for feat/overview-changes R5: the Chat overview's 当前分支 row reads the branch's real
// `git.compare.files` numbers and opens Source Control in its Branch scope, also when Source Control was
// left in Changes. It builds and starts the production app on an isolated profile/data/pipe with the fake
// Codex app-server of qa/chat-plan-real.mjs (its plan makes the overview card appear). It never starts a
// real agent CLI and never touches the user's profile.
//   THREADTERM_TEST_GIT=<absolute git.exe> node qa/overview-changes-real.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/fake-codex-plan.cjs');
const gitExe = process.env.THREADTERM_TEST_GIT;
const out = join(root, 'qa/results/overview-changes-real');
const scratch = await mkdtemp(join(tmpdir(), 'tt-overview-changes-'));
const appDir = join(scratch, 'app');
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const log = join(scratch, 'codex-plan-requests.jsonl');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app; let page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const composer = id => page.locator(`[data-testid="session-chat-${id}"] .chat-compose-shell textarea`);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(150); } }
async function shot(name) { await delay(200); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function buildApp() { await mkdir(appDir, { recursive: true }); for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' }); await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } }); await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'overview-changes-qa', version: '0.1.0', main: 'main.cjs' })); }
const git = (...args) => execFileSync(gitExe, args, { cwd: workspace, windowsHide: true, encoding: 'utf8' });

try {
  assert.ok(gitExe && existsSync(gitExe), 'Set THREADTERM_TEST_GIT to an absolute existing Git executable');
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(fixture), 'missing fake Codex plan fixture');
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true }); await mkdir(bin, { recursive: true }); await mkdir(workspace, { recursive: true }); await writeFile(log, '');
  // A branch with one committed file (+3) and one uncommitted edit (+1) against main.
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'qa@example.invalid'); git('config', 'user.name', 'QA'); git('config', 'core.autocrlf', 'false');
  await writeFile(join(workspace, 'README.md'), '# overview QA\n'); git('add', '.'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat/qa-overview');
  await writeFile(join(workspace, 'feature.txt'), 'one\ntwo\nthree\n'); git('add', '.'); git('commit', '-q', '-m', 'feature');
  await writeFile(join(workspace, 'README.md'), '# overview QA\nuncommitted line\n');
  await buildApp();
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nnode ${JSON.stringify(fixture)}\r\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [bin, dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    CODEX_HOME: join(scratch, 'codex-home'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-overview-changes-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    // Without it the runtime resolves the user's real Codex install instead of the fake on PATH.
    THREADTERM_QA_PROVIDER_BIN: bin,
    THREADTERM_QA_CODEX_PLAN_LOG: log,
    THREADTERM_QA_CODEX_PLAN_CWD: workspace,
    THREADTERM_QA_OVERVIEW_NOTE: join(workspace, 'session-note.txt'),
  });
  await mkdir(env.CODEX_HOME, { recursive: true });
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
  const initial = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });

  const project = await request('project.add', { path: workspace, name: 'Overview changes QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: workspace, title: 'Overview changes QA', provider: 'codex', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(() => composer(chat.id).isEnabled(), 'chat composer ready');
  await composer(chat.id).fill('Write a plan and start.');
  await page.locator(`[data-testid="session-chat-${chat.id}"] .chat-compose-send[type=submit]`).click();
  const scope = page.locator(`[data-testid="session-chat-${chat.id}"]`);
  // The fake turn's plan gives the card a reason to exist; docked at this width, else the popover.
  const card = async () => {
    await until(async () => (await page.locator('.chat-overview-button').count()) + (await scope.locator('.chat-overview-dock').count()) > 0, 'overview control appears');
    if (await scope.locator('.chat-overview-dock').count()) return scope.locator('.chat-overview-dock');
    if (await page.locator('.chat-overview-popover').count() === 0) await page.locator('.chat-overview-button').click();
    return page.locator('.chat-overview-popover');
  };
  let overview = await card();
  const branchRow = () => overview.locator('.chat-overview-change.is-branch');
  await until(async () => (await branchRow().count()) === 1, 'the Current branch row appears', 45_000);
  const branchLabel = await branchRow().getAttribute('aria-label');
  assert.equal(branchLabel, 'Current branch: 2 files, 4 added, 0 removed', `branch row reads git.compare.files (${branchLabel})`);
  const head = overview.locator('.chat-overview-branch-name');
  assert.equal((await head.textContent())?.trim(), 'feat/qa-overview', 'the 变更 head names the checked-out branch');
  assert.equal(await head.getAttribute('title'), 'feat/qa-overview compared with main, uncommitted changes included');
  check('the Current branch row shows the real branch diff against main, uncommitted work included');
  // README was edited before the session began, so this session has changed nothing yet: no session row.
  assert.equal(await overview.locator('.chat-overview-change.is-session').count(), 0, 'edits made before the session do not count as its own');
  // A file written after the session started is the session's change; reopening the card reloads it.
  await writeFile(join(workspace, 'session-note.txt'), 'first\nsecond\n');
  if (await page.locator('.chat-overview-popover').count()) { await page.keyboard.press('Escape'); await page.locator('.chat-overview-popover').waitFor({ state: 'detached' }); }
  overview = await card();
  const sessionRow = overview.locator('.chat-overview-change.is-session');
  await until(async () => (await sessionRow.count()) === 1, 'the This session row appears for a file written during the session', 45_000);
  assert.equal(await sessionRow.getAttribute('aria-label'), 'This session: 1 file, 2 added, 0 removed');
  await until(async () => await branchRow().getAttribute('aria-label') === 'Current branch: 3 files, 6 added, 0 removed', 'the branch row counts the new file too');
  check('This session counts only what changed since the session began; the branch row includes it');
  await shot('overview-changes-light.png');

  const scopeTab = name => page.locator('.wb-scope-tab', { hasText: name });
  await branchRow().click();
  await until(async () => (await scopeTab('Branch').count()) > 0 && await scopeTab('Branch').first().getAttribute('aria-selected') === 'true', 'Source Control opens in its Branch scope');
  await until(async () => (await page.locator('.wb-branch-group').count()) > 0, 'the branch scope lists the compared files');
  check('a click on Current branch opens Source Control in the Branch scope');
  await shot('scm-branch-scope.png');

  // Leave Source Control in Changes; the row must switch it back, not only focus it.
  await scopeTab('Changes').first().click();
  await until(async () => await scopeTab('Changes').first().getAttribute('aria-selected') === 'true', 'Source Control back in Changes');
  overview = await card();
  await branchRow().click();
  await until(async () => await scopeTab('Branch').first().getAttribute('aria-selected') === 'true', 'the row switches an open Changes scope to Branch');
  check('the row switches an already open Source Control from Changes to Branch');

  // A genuine provider turn is snapshotted on both sides. A later disk edit must never appear in that diff.
  await until(() => composer(chat.id).isEnabled(), 'composer available for the edit turn');
  await composer(chat.id).fill('Edit the review note.');
  await scope.locator('.chat-compose-send[type=submit]').click();
  const captured = await until(async () => (await request('chat.read', { sessionId: chat.id }))
    .find(item => item.turnReview?.fileCount === 1)?.turnReview, 'after-turn checkpoint pair');
  assert.notEqual(captured.from, captured.to);
  await writeFile(join(workspace, 'session-note.txt'), 'later disk edit\n');
  overview = await card();
  const turnRow = overview.locator('.chat-overview-change.is-turn');
  await turnRow.waitFor();
  assert.equal(await turnRow.getAttribute('aria-label'), 'This turn: 1 file');
  await turnRow.click();
  const review = page.locator('.chat-overview-review');
  const noteDiff = review.locator('[data-review-file="session-note.txt"] .cm-editor').first();
  await noteDiff.waitFor();
  const code = await noteDiff.textContent();
  assert.match(code, /first/);
  assert.match(code, /the agent changed this note/);
  assert.doesNotMatch(code, /later disk edit/);
  await shot('overview-turn-review-real.png');
  await page.keyboard.press('Escape');
  await review.waitFor({ state: 'detached' });
  if (await page.locator('.chat-overview-button').count()) await page.locator('.chat-overview-button').click();
  assert.equal(await page.locator('.chat-overview-change.is-turn').getAttribute('aria-label'), 'This turn: 1 file, 1 added, 2 removed');
  check('the overview opens the real start-to-end diff, and reuses its stats after closing');

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
  if (existsSync(join(scratch, 'data/runtime.log'))) await writeFile(join(out, 'runtime.log'), await readFile(join(scratch, 'data/runtime.log'))).catch(() => {});
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed ? 'OVERVIEW CHANGES REAL-APP QA PASSED' : `OVERVIEW CHANGES REAL-APP QA FAILED\n${report.errors.join('\n')}`);
}
