// Desktop-1 real-app acceptance QA for the C2 composer option chips. It builds
// and starts the production app on an isolated profile/data/pipe with a fake
// Codex app-server that advertises a 12-model catalog (grouped by provider
// prefix, one recommended) plus service tiers, reviewer, collaboration and
// sandbox settings. It never starts a real agent CLI and never touches the
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
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/fake-codex-composer.cjs');
const out = join(root, 'qa/results/chat-parity/C2/composer-options-real');
const scratch = await mkdtemp(join(tmpdir(), 'tt-composer-options-'));
const appDir = join(scratch, 'app');
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const log = join(scratch, 'codex-composer-requests.jsonl');
const report = { passed: false, checks: [], screenshots: [], paneWidths: [], errors: [] };
let app; let page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(150); } }
async function shot(name) { await delay(200); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function buildApp() { await mkdir(appDir, { recursive: true }); for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' }); await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } }); await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'composer-options-qa', version: '0.1.0', main: 'main.cjs' })); }

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(fixture), 'missing fake Codex composer fixture');
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true }); await mkdir(bin, { recursive: true }); await mkdir(workspace, { recursive: true }); await writeFile(log, '');
  await buildApp();
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nnode ${JSON.stringify(fixture)}\r\n`);
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(value => /\\cmd\\git\.exe$/i.test(value)) || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean); assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [bin, dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    CODEX_HOME: join(scratch, 'codex-home'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-composer-options-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_QA_CODEX_COMPOSER_LOG: log,
    THREADTERM_QA_CODEX_COMPOSER_CWD: workspace,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');
  await mkdir(env.CODEX_HOME, { recursive: true });
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
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

  const project = await request('project.add', { path: workspace, name: 'Composer options QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: workspace, title: 'Composer options QA', provider: 'codex', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const scope = page.locator(`[data-testid="session-chat-${chat.id}"]`);
  await until(async () => (await scope.locator('.chat-compose-shell textarea').count()) > 0, 'chat composer ready');
  await until(async () => (await scope.locator('.chat-model-chip').innerText()).trim().length > 1, 'model chip loaded');

  // One chip per native option, in runtime order.
  await until(async () => (await scope.locator('.chat-option-chip[data-option-id]').count()) === 4, 'the four extra Codex option chips');
  assert.equal(await scope.locator('.chat-mode-chip').count(), 1, 'one mode chip');
  assert.equal(await scope.locator('.chat-model-chip').count(), 1, 'one model chip');
  for (const id of ['collaboration', 'sandbox', 'fast', 'reviewer']) assert.equal(await scope.locator(`.chat-option-chip[data-option-id="${id}"]`).count(), 1, `${id} chip`);
  assert.match(await scope.locator('.chat-option-chip[data-option-id="fast"]').innerText(), /Fast mode: Off/);
  assert.match(await scope.locator('.chat-option-chip[data-option-id="collaboration"]').innerText(), /Default/);
  assert.match(await scope.locator('.chat-option-chip[data-option-id="sandbox"]').innerText(), /Workspace write/);
  check('the real app shows mode, model and one chip per remaining native Codex option');

  // The model menu searches, groups by provider prefix and badges the recommended value.
  await scope.locator('.chat-model-chip').click();
  const modelMenu = scope.locator('.chat-menu-model');
  await modelMenu.waitFor();
  assert.equal(await modelMenu.locator('.chat-menu-search').count(), 1, '12 models show the search field');
  assert.equal(await modelMenu.locator('.chat-menu-group').count(), 2, 'the catalog groups by provider prefix');
  assert.ok(await modelMenu.locator('.chat-menu-badge').count() >= 1, 'the recommended model carries a badge');
  await modelMenu.locator('.chat-menu-search').fill('Claude QA B');
  assert.equal(await modelMenu.locator('.chat-menu-item', { hasText: 'Claude QA B' }).count(), 1, 'search filters the grouped list');
  assert.equal(await modelMenu.locator('.chat-menu-group').count(), 1, 'search narrows the groups to one');
  await modelMenu.locator('.chat-menu-item', { hasText: 'Claude QA B' }).click();
  await until(async () => (await scope.locator('.chat-model-name').innerText()).includes('Claude QA B'), 'model chip updates');
  check('the real model menu searches, groups and badges, and the selection updates the chip');

  // Fast mode toggles through the native service tier.
  await scope.locator('.chat-option-chip[data-option-id="fast"]').click();
  await until(async () => /Fast mode: On/.test(await scope.locator('.chat-option-chip[data-option-id="fast"]').innerText()), 'fast mode turns on');
  await until(async () => (await request('chat.options', { sessionId: chat.id })).options.some(option => option.id === 'fast' && option.value === 'true'), 'fast mode persisted');
  check('Fast mode toggles on and persists through chat.options');

  // Sandbox and collaboration select chips round-trip.
  await scope.locator('.chat-option-chip[data-option-id="sandbox"]').click();
  await scope.locator('.chat-option-chip[data-option-id="sandbox"] + .chat-compose-menu .chat-menu-item', { hasText: 'Full access' }).click();
  await until(async () => /Full access/.test(await scope.locator('.chat-option-chip[data-option-id="sandbox"]').innerText()), 'sandbox chip updates');
  await scope.locator('.chat-option-chip[data-option-id="collaboration"]').click();
  await scope.locator('.chat-option-chip[data-option-id="collaboration"] + .chat-compose-menu .chat-menu-item', { hasText: 'Plan' }).click();
  await until(async () => /Plan/.test(await scope.locator('.chat-option-chip[data-option-id="collaboration"]').innerText()), 'collaboration chip updates');
  await scope.locator('.chat-option-chip[data-option-id="reviewer"]').click();
  await scope.locator('.chat-option-chip[data-option-id="reviewer"] + .chat-compose-menu .chat-menu-item', { hasText: 'Auto review' }).click();
  await until(async () => /Auto review/.test(await scope.locator('.chat-option-chip[data-option-id="reviewer"]').innerText()), 'reviewer chip updates');
  const persisted = await request('chat.options', { sessionId: chat.id });
  const value = id => persisted.options.find(option => option.id === id)?.value;
  assert.equal(value('sandbox'), 'danger-full-access', 'sandbox persisted the native policy');
  assert.equal(value('collaboration'), 'plan', 'collaboration persisted');
  assert.equal(value('reviewer'), 'auto_review', 'reviewer persisted');
  const requests = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const settingsCalls = requests.filter(entry => entry.method === 'thread/settings/update').map(entry => entry.params);
  assert.ok(settingsCalls.some(params => params.serviceTier === 'priority'), 'fast mode sent serviceTier=priority');
  assert.ok(settingsCalls.some(params => params.sandboxPolicy?.type === 'dangerFullAccess'), 'sandbox sent the native policy');
  assert.ok(settingsCalls.some(params => params.collaborationMode?.mode === 'plan'), 'collaboration sent the native mode');
  assert.ok(settingsCalls.some(params => params.approvalsReviewer === 'auto_review'), 'reviewer sent approvalsReviewer');
  assert.equal(await scope.locator('.surface-error').count(), 0, 'every setting update confirmed without an error banner');
  check('sandbox, collaboration and reviewer chips round-trip through thread/settings/update');

  // Matrix: each theme/locale/width keeps a single-line row with zero violations.
  for (const theme of ['light', 'dark']) for (const locale of ['en', 'zh-CN']) for (const width of [1440, 1100, 700]) {
    const snapshot = await request('runtime.snapshot');
    await request('settings.update', { patch: { language: locale, theme }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
    await page.setViewportSize({ width, height: 900 });
    await delay(250);
    const layout = await scope.locator('.chat-compose-bar').evaluate(bar => {
      const left = bar.querySelector('.chat-compose-left').getBoundingClientRect();
      const right = bar.querySelector('.chat-compose-right').getBoundingClientRect();
      const tops = [...bar.querySelectorAll('.chat-compose-left > *, .chat-compose-right > *')].map(node => node.getBoundingClientRect().top);
      return { leftTop: left.top, rightTop: right.top, minTop: Math.min(...tops), maxTop: Math.max(...tops), height: bar.getBoundingClientRect().height, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth };
    });
    assert.ok(Math.abs(layout.leftTop - layout.rightTop) < 2 && layout.maxTop - layout.minTop < 2, `${theme}/${locale}/${width}: one line`);
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${theme}/${locale}/${width}: no composer overflow`);
    const consistency = await checkControlConsistency(page, `.chat-compose-bar`);
    assertNoControlViolations(consistency, `${theme}/${locale}/${width} composer`);
    report.paneWidths.push({ label: `${theme}/${locale}/${width}`, viewport: await page.evaluate(() => window.innerWidth), pane: await scope.locator('.chat-compose-bar').evaluate(node => node.clientWidth) });
    await shot(`composer-real-${theme}-${locale}-${width}.png`);
  }
  check('light/dark, en/zh-CN, 1440/1100/700: one single-line composer row and zero consistency violations');

  // The true 420 px fold is isolated in qa/composer-options-visual.mjs; record the
  // window minimum here instead of pretending the pane shrank.
  const pane = await scope.locator('.chat-compose-bar').evaluate(node => node.clientWidth);
  report.checks.push(`real-app viewport floor recorded (composer bar ${pane}px; the window min width keeps the pane wide)`);

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
  console.log(report.passed ? 'COMPOSER OPTIONS REAL-APP QA PASSED' : `COMPOSER OPTIONS REAL-APP QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
