// Real ChatView + isolated runtime + fake Codex. No account or model request.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

const qaDir = dirname(fileURLToPath(import.meta.url));
const v3Root = resolve(qaDir, '..');
const fixture = resolve(qaDir, 'fixtures/fake-codex-slash.cjs');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? resolve(v3Root, 'runtime/target/debug/threadterm-v3-runtime.exe');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-codex-slash-'));
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const log = join(scratch, 'codex-requests.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-codex-slash-${randomUUID()}`;
const report = { passed: false, scratch, runtime, checks: [] };
let app;
let page;

async function request(method, params = {}) {
  return page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
}
async function requests() {
  return (await readFile(log, 'utf8')).split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}
async function send(text) {
  // A trailing space closes the command suggestion list; submit trims it.
  await page.locator('.chat-compose-shell textarea').fill(/^\/\w+$/u.test(text) ? `${text} ` : text);
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
  await copyFile(process.execPath, join(bin, 'codex.exe'));
  await writeFile(join(bin, 'app-server'), `require(${JSON.stringify(fixture)});\n`);
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
  await page.locator('.app-shell').waitFor();
  await request('project.add', { path: workspace, name: 'Codex slash QA', operationId: randomUUID() });
  const session = await request('session.create', { cwd: workspace, provider: 'codex', mode: 'chat', title: 'Codex slash QA', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.locator('.chat-compose-shell textarea').waitFor();
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
    await page.screenshot({ path: join(scratch, 'failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (page) await request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await writeFile(join(scratch, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
