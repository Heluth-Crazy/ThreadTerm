// Desktop-1 real-app acceptance QA for the B4 agent plan panel. It builds and
// starts the production app on an isolated profile/data/pipe with a fake Codex
// app-server that emits one turn/plan/updated during a turn. It never starts a
// real agent CLI (the shim only answers the app-server protocol) and never
// touches the user's profile or clipboard.
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/fake-codex-plan.cjs');
const out = join(root, 'qa/results/chat-parity/B4/plan-real');
const scratch = await mkdtemp(join(tmpdir(), 'tt-chat-plan-'));
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
async function buildApp() { await mkdir(appDir, { recursive: true }); for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' }); await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } }); await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'chat-plan-qa', version: '0.1.0', main: 'main.cjs' })); }

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(fixture), 'missing fake Codex plan fixture');
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true }); await mkdir(bin, { recursive: true }); await mkdir(workspace, { recursive: true }); await writeFile(log, '');
  await buildApp();
  // Fake Codex: a cmd shim runs the fixture regardless of the app-server
  // `-c` overrides the runtime puts before the `app-server` argument.
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nnode ${JSON.stringify(fixture)}\r\n`);
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(value => /\\cmd\\git\.exe$/i.test(value)) || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean); assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [bin, dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    CODEX_HOME: join(scratch, 'codex-home'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-chat-plan-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_QA_CODEX_PLAN_LOG: log,
    THREADTERM_QA_CODEX_PLAN_CWD: workspace,
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

  const project = await request('project.add', { path: workspace, name: 'Chat plan QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: workspace, title: 'Chat plan QA', provider: 'codex', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  try { await until(() => composer(chat.id).isEnabled(), 'chat composer ready'); }
  catch (error) {
    const link = await request('chat.connection', { sessionId: chat.id }).catch(() => undefined);
    throw new Error(`${error.message}${link ? ` (${link.phase}${link.error ? `: ${link.error.code} ${link.error.message}` : ''})` : ''}`);
  }
  await composer(chat.id).fill('Write a plan and start.');
  await page.locator(`[data-testid="session-chat-${chat.id}"] .chat-compose-send[type=submit]`).click();
  const scope = page.locator(`[data-testid="session-chat-${chat.id}"]`);
  await scope.locator('.chat-plan-panel').waitFor({ timeout: 30_000 });
  await until(async () => (await scope.locator('.chat-plan-entry').count()) === 3, 'plan entries rendered');

  // The runtime projected the native plan into a persisted plan part.
  const items = await request('chat.read', { sessionId: chat.id });
  const planPart = items.flatMap(item => item.parts).find(part => part.type === 'plan');
  assert.ok(planPart, 'the runtime persisted a plan part');
  assert.equal(planPart.toolId.startsWith('plan:'), true, `plan part is one-per-turn (${planPart.toolId})`);
  assert.equal(planPart.data.entries.length, 3, 'the plan part carries every step');
  assert.equal(planPart.data.entries[1].status, 'in_progress', 'native inProgress maps to in_progress');
  assert.equal(planPart.data.explanation, 'The agent wrote this plan before editing.');
  assert.equal(await scope.locator('.chat-part.plan').count(), 0, 'the plan never renders inline in the transcript');
  check('a fake Codex turn projects a persisted plan part that the panel shows and the transcript hides');

  assert.equal(await scope.locator('.chat-plan-label').textContent(), 'Plan 1/3', 'the chip count is completed/total');
  assert.equal(await scope.locator('.chat-plan-chip').getAttribute('aria-expanded'), 'true', 'a live plan auto-opens');
  assert.match(await scope.locator('.chat-plan-explanation').textContent(), /wrote this plan/);
  check('the chip shows completed/total and the card auto-opens with the explanation');

  await scope.locator('.chat-plan-chip').press('Escape');
  assert.equal(await scope.locator('.chat-plan-chip').getAttribute('aria-expanded'), 'false', 'Escape collapses the card');
  await scope.locator('.chat-plan-chip').click();
  assert.equal(await scope.locator('.chat-plan-chip').getAttribute('aria-expanded'), 'true', 'the chip toggles the card');
  check('keyboard Escape collapses and the chip toggles');

  for (const theme of ['light', 'dark']) for (const width of [1440, 420]) for (const locale of ['en', 'zh-CN']) {
    const snapshot = await request('runtime.snapshot');
    await request('settings.update', { patch: { language: locale, theme }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
    await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth, 900), width);
    await until(async () => (await scope.locator('.chat-plan-panel').count()) > 0, `${locale}/${theme}/${width} plan panel`);
    if (await scope.locator('.chat-plan-chip').getAttribute('aria-expanded') === 'false') await scope.locator('.chat-plan-chip').click();
    await scope.locator('.chat-plan-card').waitFor();
    // V1-2: the expanded card stays in flow under the sticky chip, so at the top
    // of the transcript it sits above the first message and never intersects one.
    await scope.locator('.v3-chat-log').evaluate(node => { node.scrollTop = 0; });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const planFlow = await scope.locator('.v3-chat-log').evaluate(log => {
      const card = log.querySelector('.chat-plan-card');
      if (!card) return { hits: 0, cardBottom: null, firstTop: null };
      const cardRect = card.getBoundingClientRect();
      const messages = [...log.querySelectorAll('.v3-chat-message')].map(node => node.getBoundingClientRect());
      const hits = messages.filter(rect => rect.left < cardRect.right && rect.right > cardRect.left && rect.top < cardRect.bottom && rect.bottom > cardRect.top);
      const first = [...log.querySelectorAll('.v3-chat-message')].map(node => node.getBoundingClientRect()).sort((a, b) => a.top - b.top)[0];
      return { hits: hits.length, cardBottom: cardRect.bottom, firstTop: first ? first.top : null };
    });
    assert.equal(planFlow.hits, 0, `${locale}/${theme}/${width}: the expanded plan card does not intersect any message bubble in the initial view`);
    assert.ok(planFlow.firstTop === null || planFlow.cardBottom <= planFlow.firstTop + 0.5, `${locale}/${theme}/${width}: the expanded plan card sits in flow above the first message`);
    await shot(`plan-real-${theme}-${width}-${locale}.png`);
    const label = await scope.locator('.chat-plan-label').textContent();
    assert.match(label, /^(Plan|计划) 1\/3$/, `${locale} chip label`);
    assert.equal(await scope.locator('.chat-plan-entry').count(), 3, `${locale}/${theme}/${width} entries`);
    const overflow = await scope.locator('.chat-log-shell').evaluate(element => element.scrollWidth - element.clientWidth);
    assert.ok(overflow <= 1, `${locale}/${theme}/${width} has no horizontal overflow (${overflow})`);
  }
  check('light/dark, en/zh-CN, wide and 420 px matrix shows the plan panel without overflow');

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
  console.log(report.passed ? 'CHAT PLAN REAL-APP QA PASSED' : `CHAT PLAN REAL-APP QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
