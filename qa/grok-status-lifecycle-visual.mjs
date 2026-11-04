// Real ChatView + isolated runtime + fake Grok /status. No account or model request.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
const qaDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(qaDir, '..');
const fixture = join(qaDir, 'fixtures', 'fake-grok-status.cjs');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? process.env.THREADTERM_QA_RUNTIME_EXE ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-grok-status-lifecycle-'));
const bin = join(scratch, 'bin'), workspace = join(scratch, 'workspace'), data = join(scratch, 'data'), profile = join(scratch, 'profile');
const log = join(scratch, 'grok-requests.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-grok-status-${randomUUID()}`;
const out = join(root, 'qa/results/grok-status-lifecycle');
const report = { passed: false, scratch, runtime, checks: [] };
const { appDir, cleanup: cleanupApp } = await buildQaApp({ root });
let app, page;

const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() <= end) {
    try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`);
}
async function requests() { return (await readFile(log, 'utf8')).split(/\r?\n/u).filter(Boolean).map(JSON.parse); }
async function send(text) {
  const field = page.locator('.chat-compose-shell textarea');
  const submit = page.locator('.chat-compose-send[type="submit"]');
  await until(async () => { await field.fill(/^\/\w+$/u.test(text) ? `${text} ` : text); return submit.isEnabled(); }, `composer accepts ${text}`);
  await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
}
async function waitStatus(sessionId, command, text) {
  await until(async () => {
    const items = await request('chat.read', { sessionId });
    const user = [...items].reverse().find(item => item.role === 'user' && item.parts.some(part => part.text === command));
    return user?.turnId && items.some(item => item.turnId === user.turnId && item.parts.some(part => part.text?.includes(text)));
  }, `${command} result`);
  await until(async () => (await request('runtime.snapshot')).sessions.find(item => item.id === sessionId)?.status === 'idle', `${command} idle`, 5_000);
  await until(async () => (await request('runtime.snapshot')).sessions.find(item => item.id === sessionId)?.activity?.state === 'awaiting_input', `${command} activity`, 5_000);
  await page.locator('.chat-first-response-wait').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.chat-compose-send.is-stop').count(), 0);
}

try {
  await Promise.all([mkdir(bin), mkdir(workspace), mkdir(data), mkdir(profile), mkdir(out, { recursive: true })]);
  await writeFile(log, '');
  await writeFile(join(bin, 'grok.cmd'), `@echo off\r\nnode ${JSON.stringify(fixture)} %*\r\n`);
  const forbidden = new Set(['path', 'threadterm_qa_provider_bin', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !forbidden.has(key.toLowerCase())));
  env.Path = [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';');
  env.THREADTERM_QA_PROVIDER_BIN = bin;
  env.THREADTERM_V3_DATA = data;
  env.THREADTERM_V3_USER_DATA = profile;
  env.THREADTERM_V3_PIPE = pipe;
  env.THREADTERM_V3_RUNTIME = runtime;
  env.THREADTERM_QA_GROK_STATUS_LOG = log;
  env.THREADTERM_QA_GROK_STATUS_CWD = workspace;
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached' });
  await request('project.add', { path: workspace, name: 'Grok status QA', operationId: randomUUID() });
  const session = await request('session.create', { cwd: workspace, provider: 'grok', mode: 'chat', title: 'Grok status QA', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(() => page.locator('.chat-compose-shell textarea').isEnabled(), 'chat composer ready');
  report.checks.push('real ChatView connected through isolated runtime to fake Grok');

  await send('/status');
  await waitStatus(session.id, '/status', 'Grok session status');
  assert.equal((await requests()).filter(row => row.method === '_x.ai/session/info').length, 1);
  assert.equal((await requests()).some(row => row.method === 'session/prompt'), false);
  report.checks.push('/status renders a result and settles activity without a model turn');

  await send('/info');
  await waitStatus(session.id, '/info', 'Grok session status');
  await send('/status bad');
  await waitStatus(session.id, '/status bad', 'does not accept arguments');
  assert.equal((await requests()).filter(row => row.method === '_x.ai/session/info').length, 2);
  await send('/context');
  await waitStatus(session.id, '/context', 'QA status unavailable');
  assert.equal((await requests()).filter(row => row.method === '_x.ai/session/info').length, 3);
  report.checks.push('aliases, argument feedback, and native status errors all settle activity');

  const lease = await request('session.claim', { sessionId: session.id, clientId: 'grok-status-qa' });
  await send('hold a native turn');
  await page.locator('.chat-compose-send.is-stop').waitFor();
  const operationId = randomUUID();
  await assert.rejects(request('chat.send', { sessionId: session.id, text: '/status', operationId, leaseEpoch: lease.leaseEpoch }));
  assert.equal((await request('chat.read', { sessionId: session.id })).some(item => item.turnId === operationId), false);
  assert.equal((await request('runtime.snapshot')).sessions.find(item => item.id === session.id)?.activity?.state, 'running');
  await page.locator('.chat-compose-send.is-stop').waitFor();
  report.checks.push('/status rejects while native work retains Processing and Stop');
  await page.locator('.chat-compose-send.is-stop').click();
  await page.locator('.chat-compose-send[type="submit"]').waitFor();
  await page.screenshot({ path: join(out, 'status-settled.png') });
  report.passed = true;
} catch (failure) {
  report.error = failure instanceof Error ? failure.stack : String(failure);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await cleanupApp();
}
