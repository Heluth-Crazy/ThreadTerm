// Real ChatView + isolated runtime + fake Codex. No account or model request.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { buildQaApp } from './lib/qa-app.mjs';
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

const qaDir = dirname(fileURLToPath(import.meta.url));
const v3Root = resolve(qaDir, '..');
const fixture = resolve(qaDir, 'fixtures/fake-codex-slash.cjs');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? process.env.THREADTERM_QA_RUNTIME_EXE ?? resolve(v3Root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-codex-status-lifecycle-'));
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const log = join(scratch, 'codex-requests.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-codex-status-lifecycle-${randomUUID()}`;
const out = resolve(v3Root, 'qa/results/codex-status-lifecycle');
await mkdir(out, { recursive: true });
const report = { passed: false, scratch, runtime, checks: [] };
const { appDir, cleanup: cleanupApp } = await buildQaApp({ root: v3Root });
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
try {
  await Promise.all([mkdir(bin), mkdir(workspace), mkdir(data), mkdir(profile)]);
  await writeFile(log, '');
  // Swallow Codex `-c` overrides (node-as-codex.exe treated `-c` as `--check`).
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nnode ${JSON.stringify(fixture)}\r\n`);
  const forbidden = new Set(['path', 'codex_home', 'openai_api_key', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !forbidden.has(key.toLowerCase())));
  env.Path = [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';');
  env.THREADTERM_QA_PROVIDER_BIN = bin;
  env.CODEX_HOME = join(scratch, 'provider-home');
  env.THREADTERM_V3_DATA = data;
  env.THREADTERM_V3_USER_DATA = profile;
  env.THREADTERM_V3_PIPE = pipe;
  env.THREADTERM_V3_RUNTIME = runtime;
  env.THREADTERM_QA_CODEX_SLASH_LOG = log;
  env.THREADTERM_QA_CODEX_SLASH_CWD = workspace;
  await mkdir(env.CODEX_HOME);
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__lane2Clipboard=value;},readText:async()=>window.__lane2Clipboard??''}}));
  await page.locator('#boot-splash').waitFor({state:'detached'});
  await page.evaluate(()=>{document.title='ThreadTerm Codex status lifecycle QA';});
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await request('project.add', { path: workspace, name: 'Codex slash QA', operationId: randomUUID() });
  const session = await request('session.create', { cwd: workspace, provider: 'codex', mode: 'chat', title: 'Codex slash QA', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(() => page.locator('.chat-compose-shell textarea').isEnabled(), 'chat composer ready');
  await page.locator('.chat-model-chip').filter({ hasText: 'QA Model A' }).waitFor({ timeout: 30_000 });
  report.checks.push('real ChatView connected through isolated runtime to fake Codex');

  for (const command of ['/status', '/usage']) {
    await send(command);
    await until(async () => {
      const items = await request('chat.read', { sessionId: session.id });
      const user = [...items].reverse().find(item => item.role === 'user' && item.parts.some(part => part.text === command));
      return user?.turnId && items.some(item => item.turnId === user.turnId && item.parts.some(part => part.type === 'status' && part.status === 'complete'));
    }, `${command} status result`);
    await until(async () => (await request('runtime.snapshot')).sessions.find(item => item.id === session.id)?.status === 'idle', `${command} returns to idle`, 5_000);
    await until(async () => (await request('runtime.snapshot')).sessions.find(item => item.id === session.id)?.activity?.state === 'awaiting_input', `${command} activity settles after completion`, 5_000);
    await page.locator('.chat-first-response-wait').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.chat-compose-send.is-stop').count(), 0);
    assert.equal((await requests()).filter(item => item.method === 'turn/start').length, 0);
    report.checks.push(`${command} displays status, returns to idle, releases Processing/Stop without a model turn`);
  }

  const lease = await request('session.claim', { sessionId: session.id, clientId: 'codex-status-qa' });
  await send('hold a normal turn');
  await page.locator('.chat-compose-send.is-stop').waitFor();
  for (const text of ['/status', '/usage']) {
    const operationId = randomUUID();
    await assert.rejects(request('chat.send', { sessionId: session.id, text, operationId, leaseEpoch: lease.leaseEpoch }));
    assert.equal((await request('chat.read', { sessionId: session.id })).some(item => item.turnId === operationId), false);
    const active = (await request('runtime.snapshot')).sessions.find(item => item.id === session.id);
    assert.equal(active.activity.state, 'running');
    await page.locator('.chat-compose-send.is-stop').waitFor();
  }
  report.checks.push('status and usage reject during real native work without changing activity or Stop');
  await page.locator('.chat-compose-send.is-stop').click();
  await page.locator('.chat-compose-send[type="submit"]').waitFor();
  await page.screenshot({ path: join(out, 'status-settled.png') });
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
  await cleanupApp();
}
