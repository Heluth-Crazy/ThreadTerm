// Real Electron visual QA for native Codex question cards. It uses only the
// deterministic fake fixture and is intended for a Desktop-1 run by Claude.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const qa = dirname(fileURLToPath(import.meta.url));
const root = resolve(qa, '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
process.env.TT_QA_DESKTOP = '1';
const runtime = resolve(option('--runtime') ?? process.env.THREADTERM_QA_RUNTIME_EXE ?? join(root, 'runtime', 'target-qa', 'debug', 'threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `Missing QA runtime: ${runtime}`);

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-question-app-'));
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const fixture = resolve(qa, 'fixtures', 'fake-codex-questions.cjs');
const log = join(scratch, 'fake-codex-questions.jsonl');
const out = resolve(root, 'qa', 'results', 'chat-parity', 'D1', 'question-app');
assert.ok(existsSync(fixture), `Missing fake Codex question fixture: ${fixture}`);
const { appDir, cleanup: cleanupApp } = await buildQaApp({ root });

// Strip every inherited PATH spelling before installing the only codex.exe.
const blocked = new Set(['path', 'codex_home', 'openai_api_key', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_dev_server_url']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.has(key.toLowerCase())));
Object.assign(env, {
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: join(scratch, 'data'),
  THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-question-app-${randomUUID()}`,
  THREADTERM_V3_RUNTIME: runtime,
  CODEX_HOME: join(scratch, 'provider-home'),
  TT_QA_NODE: process.execPath,
  TT_QA_SCRIPT: fixture,
  THREADTERM_QA_CODEX_QUESTIONS_LOG: log,
  THREADTERM_QA_CODEX_QUESTIONS_CWD: workspace,
});
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'all inherited PATH spellings were removed');
assert.deepEqual(env.Path.split(';'), [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')], 'only the fake-provider shim, Node and System32 are on PATH');

let app;
let page;
let project;
let session;
let leaseEpoch;
const pageErrors = [];
const report = { passed: false, runtime, scratch, screenshots: [], paneWidths: [], checks: [] };
const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const chat = () => page.locator(`[data-testid="session-chat-${session.id}"]`);
const questionCard = () => chat().locator('.chat-question-wrapper');
async function until(check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
async function setChatPaneWidth(target, label) {
  const viewport = page.viewportSize();
  const initialWidth = viewport?.width ?? 1440;
  const initialPaneWidth = await chat().evaluate(node => Math.round(node.getBoundingClientRect().width));
  let width = Math.max(720, Math.round(target + initialWidth - initialPaneWidth));
  await page.setViewportSize({ width, height: 900 });
  let paneWidth = await chat().evaluate(node => Math.round(node.getBoundingClientRect().width));
  if (Math.abs(paneWidth - target) > 8) {
    width = Math.max(720, width + target - paneWidth);
    await page.setViewportSize({ width, height: 900 });
    paneWidth = await chat().evaluate(node => Math.round(node.getBoundingClientRect().width));
  }
  assert.ok(Math.abs(paneWidth - target) <= 8, `${label} ChatView pane is ${paneWidth}px; expected about ${target}px`);
  const fit = await chat().evaluate(node => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
  assert.ok(fit.scrollWidth <= fit.clientWidth + 1, `${label} ChatView has horizontal overflow (${fit.scrollWidth}px > ${fit.clientWidth}px)`);
  report.paneWidths.push({ label, target, viewportWidth: width, paneWidth, ...fit });
}
async function shot(prefix) {
  assertNoControlViolations(await checkControlConsistency(page, '.chat-question-wrapper'),prefix);
  for (const [target, label] of [[1000, 'wide'], [420, 'narrow']]) {
    await setChatPaneWidth(target, `${prefix}-${label}`);
    const path = join(out, `${prefix}-${label}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    report.screenshots.push(path);
  }
}
async function openScenario(prompt) {
  const cwd = join(workspace, prompt);
  await mkdir(cwd, { recursive: true });
  session = await rpc('session.create', { projectId: project.id, cwd, provider: 'codex', mode: 'chat', title: `Question app QA · ${prompt}`, operationId: randomUUID() });
  leaseEpoch = (await rpc('session.claim', { sessionId: session.id, clientId: 'question-app-visual' })).leaseEpoch;
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await chat().waitFor();
  await until(async () => (await rpc('chat.connection', { sessionId: session.id })).phase === 'ready', `Codex connection (${prompt})`);
  await rpc('chat.send', { sessionId: session.id, text: prompt, leaseEpoch, operationId: randomUUID() });
  await questionCard().waitFor();
  await until(async () => (await questionCard().locator('button.chat-approval-choice:not([disabled])').count()) >= 1, `question actions enabled (${prompt})`);
  assertNoControlViolations(await checkControlConsistency(page, '.chat-question-wrapper'), 'question app card');
  assert.equal(await questionCard().count(), 1, `${prompt} has one visible question card`);
}
async function waitAnswered(label) {
  await until(async () => (await questionCard().locator('.chat-question-status').innerText()) === 'Answered', `${label} answer receipt`);
}

try {
  await Promise.all([bin, workspace, env.THREADTERM_V3_DATA, env.THREADTERM_V3_USER_DATA, env.CODEX_HOME, out].map(path => mkdir(path, { recursive: true })));
  await writeFile(log, '');
  const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
  await writeFile(join(bin, 'shim.rs'), shim);
  const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stderr);

  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__lane2Clipboard=value;},readText:async()=>window.__lane2Clipboard??''}}));
  await page.locator('#boot-splash').waitFor({state:'detached'});
  await page.evaluate(()=>{document.title='ThreadTerm lane2 D1 question QA';});
  const initial = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  project = await rpc('project.add', { path: workspace, name: 'Question app QA', operationId: randomUUID() });

  await openScenario('single');
  await shot('01-single-live');
  await questionCard().getByRole('radio', { name: /Blue/ }).check();
  await questionCard().getByRole('button', { name: 'Submit' }).click();
  await waitAnswered('single');
  await shot('04-answered');

  await openScenario('input');
  assert.match(await questionCard().innerText(), /1 of 2.*2 of 2/s, 'multi-question card exposes numbered questions');
  await shot('02-multi');
  await questionCard().getByRole('radio', { name: /Blue/ }).check();
  await questionCard().getByLabel('Enter token').fill('secret-token');
  await questionCard().getByRole('button', { name: 'Submit' }).click();
  await waitAnswered('multi-question');

  await openScenario('form');
  await shot('03-form');
  await questionCard().getByLabel('count').fill('2');
  await questionCard().getByLabel('colour').selectOption('red');
  await questionCard().getByRole('button', { name: 'Submit' }).click();
  await waitAnswered('form');

  const replies = (await readFile(log, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse)
    .filter(entry => entry.direction === 'in' && /^qa-(single|input|form)-\d+$/u.test(String(entry.method)))
    .map(entry => [String(entry.method).replace(/-\d+$/u, ''), entry.params]);
  assert.deepEqual(replies, [
    ['qa-single', { answers: { priority: { answers: ['Blue'] } } }],
    ['qa-input', { answers: { colour: { answers: ['Blue'] }, token: { answers: ['secret-token'] } } }],
    ['qa-form', { action: 'accept', content: { count: 2, enabled: true, colour: 'red' } }],
  ], 'the fake fixture received exact native replies from UI submissions');
  assert.deepEqual(pageErrors, [], `renderer emitted page errors:\n${pageErrors.join('\n')}`);
  report.checks = [
    'Desktop 1 inactive Electron launch with native notifications disabled',
    'all inherited PATH spellings removed; the fake Codex fixture is the only provider executable',
    'pending single-choice, multi-question and form cards captured at approximately 1000px and 420px ChatView pane widths without horizontal overflow',
    'answered state captured after UI submission',
    'fixture log contains exact native Codex replies for single, multi-question and form submits',
  ];
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await cleanupApp();
}
