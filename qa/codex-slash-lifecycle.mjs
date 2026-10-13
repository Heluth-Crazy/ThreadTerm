// Real ChatView + isolated runtime + fake Codex. No account or model request.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { checkControlConsistency, assertNoControlViolations } from './lib/visual-consistency.mjs';
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

const qaDir = dirname(fileURLToPath(import.meta.url));
const v3Root = resolve(qaDir, '..');
const fixture = resolve(qaDir, 'fixtures/fake-codex-slash.cjs');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? process.env.THREADTERM_QA_RUNTIME_EXE ?? resolve(v3Root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-codex-slash-'));
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const log = join(scratch, 'codex-requests.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-codex-slash-${randomUUID()}`;
const out = resolve(v3Root, 'qa/results/chat-parity/D2/codex-slash');
await mkdir(out, { recursive: true });
const report = { passed: false, scratch, runtime, checks: [] };
let app;
let page;

async function request(method, params = {}) {
  return page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
}
async function until(probe, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  let error;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; }
    if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`);
    await delay(150);
  }
}
async function requests() {
  return (await readFile(log, 'utf8')).split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}
async function send(text) {
  // A trailing space closes the command suggestion list; submit trims it.
  // Wait for any previous turn's first-response indicator to clear, then for
  // the composer to accept input, so a cancelled turn cannot swallow the send.
  await page.locator('.chat-first-response-wait').waitFor({ state: 'detached' }).catch(() => undefined);
  const value = /^\/\w+$/u.test(text) ? `${text} ` : text;
  const field = page.locator('.chat-compose-shell textarea');
  const submit = page.locator('.chat-compose-send[type="submit"]');
  const deadline = Date.now() + 30_000;
  for (;;) {
    // The button can briefly stay disabled while control is re-acquired after a
    // cancel or while a draft save settles; retype so React sees the input.
    await field.fill(value);
    if (await submit.isEnabled().catch(() => false)) break;
    if (Date.now() > deadline) throw new Error(`composer submit stayed disabled after typing ${JSON.stringify(text)}`);
    await delay(100);
  }
  await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
}
async function waitResult(sessionId, command, text) {
  const deadline = Date.now() + 10_000;
  let matched = false;
  while (Date.now() < deadline) {
    const items = await request('chat.read', { sessionId });
    const user = [...items].reverse().find(item => item.role === 'user' && item.parts.some(part => part.text === command));
    matched = Boolean(user?.turnId && items.some(item => item.role === 'assistant' && item.turnId === user.turnId && item.parts.some(part => part.text?.includes(text))));
    if (matched) break;
    await delay(50);
  }
  assert.ok(matched, `no ${command} result containing ${JSON.stringify(text)} in the same turn`);
  await page.locator('.v3-chat-message.assistant').filter({ hasText: text }).last().waitFor({ timeout: 10_000 });
  await page.locator('.chat-first-response-wait').waitFor({ state: 'detached', timeout: 10_000 });
}
try {
  await Promise.all([mkdir(bin), mkdir(workspace), mkdir(data), mkdir(profile)]);
  await writeFile(log, '');
  // Swallow Codex `-c` overrides (node-as-codex.exe treated `-c` as `--check`).
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nnode ${JSON.stringify(fixture)}\r\n`);
  const forbidden = new Set(['path', 'codex_home', 'openai_api_key', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !forbidden.has(key.toLowerCase())));
  env.Path = [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';');
  env.CODEX_HOME = join(scratch, 'provider-home');
  env.THREADTERM_V3_DATA = data;
  env.THREADTERM_V3_USER_DATA = profile;
  env.THREADTERM_V3_PIPE = pipe;
  env.THREADTERM_V3_RUNTIME = runtime;
  env.THREADTERM_QA_CODEX_SLASH_LOG = log;
  env.THREADTERM_QA_CODEX_SLASH_CWD = workspace;
  await mkdir(env.CODEX_HOME);
  app = await electron.launch({ args: [v3Root], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__lane2Clipboard=value;},readText:async()=>window.__lane2Clipboard??''}}));
  await page.locator('#boot-splash').waitFor({state:'detached'});
  await page.evaluate(()=>{document.title='ThreadTerm lane2 D2 slash QA';});
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await request('project.add', { path: workspace, name: 'Codex slash QA', operationId: randomUUID() });
  const session = await request('session.create', { cwd: workspace, provider: 'codex', mode: 'chat', title: 'Codex slash QA', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(() => page.locator('.chat-compose-shell textarea').isEnabled(), 'chat composer ready');
  await page.locator('.chat-model-chip').filter({ hasText: 'QA Model A' }).waitFor({ timeout: 30_000 });
  report.checks.push('real ChatView connected through isolated runtime to fake Codex');

  await send('/plan');
  await page.locator('.v3-chat-message.user').filter({ hasText: '/plan' }).waitFor();
  await waitResult(session.id, '/plan', 'Mode: plan');
  assert.equal((await requests()).filter(item => item.method === 'thread/settings/update').length, 1);
  report.checks.push('/plan produced visible result and released wait');

  await send('/plan status');
  await waitResult(session.id, '/plan status', 'Mode: plan');
  assert.equal((await requests()).filter(item => item.method === 'thread/settings/update').length, 1);
  report.checks.push('/plan query produced local answer without provider update');

  await send('/plan impossible');
  await waitResult(session.id, '/plan impossible', 'Usage: /plan');
  assert.equal((await requests()).filter(item => item.method === 'thread/settings/update').length, 1);
  report.checks.push('/plan invalid argument showed error and released wait');

  await send('/model');
  await waitResult(session.id, '/model', 'qa-model-a');
  assert.equal((await requests()).filter(item => item.method === 'thread/settings/update').length, 1);
  report.checks.push('/model query read current model without a provider update');

  await send('/model qa-model-b');
  await waitResult(session.id, '/model qa-model-b', 'qa-model-b');
  assert.equal((await requests()).filter(item => item.method === 'thread/settings/update').length, 2);
  report.checks.push('/model valid value used one provider update');

  const transcript = await request('chat.read', { sessionId: session.id });
  const modelTurn = transcript.find(item => item.role === 'user' && item.parts.some(part => part.text === '/model qa-model-b'))?.turnId;
  assert.ok(modelTurn);
  const replayLease = await request('session.claim', { sessionId: session.id, clientId: 'codex-slash-qa' });
  await request('chat.send', { sessionId: session.id, text: '/model qa-model-b', operationId: modelTurn, leaseEpoch: replayLease.leaseEpoch });
  assert.equal((await requests()).filter(item => item.method === 'thread/settings/update').length, 2);
  report.checks.push('same operation replay did not reapply native setting');

  await send('/model qa-rejected');
  await waitResult(session.id, '/model qa-rejected', 'QA model rejected');
  report.checks.push('native rejection produced visible error and released wait');

  const before = await requests();
  await send('hold a normal turn');
  await page.locator('.chat-compose-send.is-stop').waitFor();
  await page.locator('.chat-first-response-wait').waitFor();
  const sent = await requests();
  assert.equal(sent.filter(item => item.method === 'turn/start').length, 1);
  assert.equal(sent.filter(item => item.method === 'thread/settings/update').length, 3);
  assert.ok(sent.length > before.length);
  report.checks.push('ordinary prompt retained waiting and Stop while fake native turn was active');

  // The runtime API bypasses the UI guard here to prove the adapter rejects
  // conflicting local commands without completing the active normal turn.
  const conflictId = randomUUID();
  await assert.rejects(request('chat.send', { sessionId: session.id, text: '/plan', operationId: conflictId, leaseEpoch: replayLease.leaseEpoch }));
  await page.locator('.chat-compose-send.is-stop').waitFor();
  assert.equal((await requests()).filter(item => item.method === 'thread/settings/update').length, 3);
  assert.equal((await request('chat.read', { sessionId: session.id })).some(item => item.turnId === conflictId), false);
  report.checks.push('conflicting local command did not update settings or finish active turn');

  await page.locator('.chat-compose-send.is-stop').click();
  await page.locator('.chat-compose-send[type="submit"]').waitFor();
  assert.equal((await requests()).filter(item => item.method === 'turn/interrupt').length, 1);
  report.checks.push('cancellation ended only the held ordinary turn');

  await send('qa fail ordinary turn');
  await waitResult(session.id, 'qa fail ordinary turn', 'QA ordinary turn failed');
  report.checks.push('ordinary native failure released first-response wait');

  await page.evaluate(() => { document.title = 'ThreadTerm lane2 D2 slash QA'; });
  assertNoControlViolations(await checkControlConsistency(page, `[data-testid="session-chat-${session.id}"]`), 'D2 slash regression');
  await page.screenshot({ path: join(out, 'wide.png') });
  report.passed = true;
} catch (failure) {
  report.error = failure instanceof Error ? failure.stack : String(failure);
  if (page) {
    report.failureState = await page.evaluate(async () => ({
      compose: document.querySelector('.chat-compose-shell textarea')?.value,
      assistant: [...document.querySelectorAll('.v3-chat-message.assistant')].map(node => node.textContent),
      waiting: Boolean(document.querySelector('.chat-first-response-wait')),
      surfaceError: document.querySelector('.surface-error')?.textContent,
    })).catch(() => undefined);
    await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (page) await request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
