// Real Electron and isolated QA runtime; native boundary is a deterministic fixture.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const delay = ms => new Promise(done => setTimeout(done, ms));
const qa = dirname(fileURLToPath(import.meta.url));
const root = resolve(qa, '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? resolve(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.match(runtime.replace(/\\/g, '/'), /runtime\/target-qa\/debug\/threadterm-v3-runtime\.exe$/, 'QA runtime required');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-codex-compat-'));
const bin = join(scratch, 'bin');
const cwd = join(scratch, 'workspace');
const log = join(scratch, 'requests.jsonl');
const forbidden = new Set(['path', 'codex_home', 'openai_api_key', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_dev_server_url']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !forbidden.has(key.toLowerCase())));
Object.assign(env, {
  THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-codex-compat-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
  CODEX_HOME: join(scratch, 'provider-home'), THREADTERM_QA_CODEX_COMPAT_LOG: log, THREADTERM_QA_CODEX_COMPAT_CWD: cwd,
});
const report = { passed: false, scratch, runtime, checks: [] };
let app, page, session;
const requests = async () => (await readFile(log, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(check, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
async function send(text, expected, menu = false) {
  const before = new Set((await rpc('chat.read', { sessionId: session.id })).map(item => item.id));
  const textarea = page.locator('.chat-compose-shell textarea');
  await textarea.fill(menu ? text : `${text} `);
  if (menu) await page.locator('.chat-slash [role="option"]').filter({ hasText: text }).click();
  await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
  let user;
  await until(async () => {
    user = (await rpc('chat.read', { sessionId: session.id })).find(item => !before.has(item.id) && item.role === 'user' && item.parts.some(part => part.text === text));
    return Boolean(user);
  }, `record ${text}`);
  if (expected) await until(async () => (await rpc('chat.read', { sessionId: session.id })).some(item => item.role === 'assistant' && item.turnId === user.turnId && item.parts.some(part => expected.test(part.text ?? ''))), `${text} result`);
  await until(async () => (await rpc('runtime.snapshot')).sessions.find(item => item.id === session.id)?.status === 'idle', `${text} completion`);
  await page.locator('.chat-first-response-wait').waitFor({ state: 'detached' });
  return user.turnId;
}
try {
  await Promise.all([bin, cwd, env.THREADTERM_V3_DATA, env.THREADTERM_V3_USER_DATA, env.CODEX_HOME].map(path => mkdir(path)));
  await writeFile(log, '');
  await copyFile(process.execPath, join(bin, 'codex.exe'));
  await writeFile(join(bin, 'app-server'), `require(${JSON.stringify(resolve(qa, 'fixtures/fake-codex-compat.cjs'))});\n`);
  env.Path = [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';');
  app = await electron.launch({ args: [root], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.threadterm));
  const settings = (await rpc('runtime.snapshot')).settings;
  await rpc('settings.update', { expectedRevision: settings.revision, patch: { language: 'en' }, operationId: randomUUID() });
  await rpc('project.add', { path: cwd, name: 'Codex fixture QA', operationId: randomUUID() });
  session = await rpc('session.create', { cwd, provider: 'codex', mode: 'chat', title: 'Codex fixture QA', operationId: randomUUID() });
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.locator('.chat-model-chip').filter({ hasText: 'QA Model A' }).waitFor({ timeout: 30_000 });
  for (const [command, result] of [
    ['/model', /Model: qa-model-a/], ['/model qa-model-b', /Model: qa-model-b/], ['/plan', /Mode: plan/],
    ['/approvals', /Approval policy: on-request/], ['/sandbox', /Sandbox: workspace-write/],
    ['/diff', /not implemented in Chat/], ['/init', /not implemented in Chat/], ['/mcp', /not implemented in Chat/],
    ['/skills', /qa-skill/], ['/memory', /not implemented in Chat/], ['/undo', /not implemented in Chat/],
    ['/help', /Chat commands:/], ['/status', /Approval policy: on-request/], ['/usage', /Codex session status/],
  ]) await send(command, result);
  assert.equal((await requests()).filter(row => row.method === 'turn/start').length, 0);
  report.checks.push('every typed local/settings/status command settled with visible same-turn result and no model prompt');
  await send('/help', /Chat commands:/, true);
  assert.equal((await requests()).filter(row => row.method === 'turn/start').length, 0);
  report.checks.push('menu-selected /help stayed local');
  await send('/compact'); await send('/review');
  const actions = await requests();
  assert.ok(actions.some(row => row.method === 'thread/compact/start'));
  assert.ok(actions.some(row => row.method === 'review/start'));
  assert.equal(actions.filter(row => row.method === 'turn/start').length, 0);
  report.checks.push('compact/review used native methods and completed their own turn identities');
  await send('/qa-skill inspect');
  assert.deepEqual((await requests()).find(row => row.method === 'turn/start')?.params.input[0], { type: 'skill', name: 'qa-skill', path: 'C:/qa/SKILL.md' });
  report.checks.push('selected project skill used structured native input');
  const lease = await rpc('session.claim', { sessionId: session.id, clientId: 'codex-fixture' });
  const op = await send('/approvals never', /Approval policy: never/);
  const count = (await requests()).filter(row => row.method === 'thread/settings/update').length;
  await rpc('chat.send', { sessionId: session.id, text: '/approvals never', operationId: op, leaseEpoch: lease.leaseEpoch });
  assert.equal((await requests()).filter(row => row.method === 'thread/settings/update').length, count);
  await send('/sandbox read-only', /Sandbox: read-only/);
  await send('/model qa-unconfirmed', /did not confirm/);
  await send('/model qa-unsupported', /does not support/);
  await send('/model qa-rejected', /QA model rejected/);
  const options = await rpc('chat.options', { sessionId: session.id });
  assert.equal(options.options.find(option => option.id === 'model').value, 'qa-model-b');
  assert.equal(options.options.find(option => option.id === 'mode').value, 'never');
  assert.equal(options.options.find(option => option.id === 'sandbox').value, 'read-only');
  report.checks.push('native confirmations adopted; replay/unconfirmed/unsupported/rejected changes never falsely updated settings');
  const hold = randomUUID();
  await rpc('chat.send', { sessionId: session.id, text: 'hold a normal turn', operationId: hold, leaseEpoch: lease.leaseEpoch });
  await page.locator('.chat-compose-send.is-stop').waitFor();
  const turns = (await requests()).filter(row => row.method === 'turn/start').length;
  await rpc('chat.send', { sessionId: session.id, text: 'hold a normal turn', operationId: hold, leaseEpoch: lease.leaseEpoch });
  assert.equal((await requests()).filter(row => row.method === 'turn/start').length, turns);
  await assert.rejects(rpc('chat.send', { sessionId: session.id, text: '/plan', operationId: randomUUID(), leaseEpoch: lease.leaseEpoch }), /active turn/);
  await page.locator('.chat-compose-send.is-stop').click();
  await page.locator('.chat-compose-send[type="submit"]').waitFor();
  assert.equal((await requests()).filter(row => row.method === 'turn/interrupt').length, 1);
  report.checks.push('active-turn conflict, replay and cancellation preserved the original turn');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: join(scratch, 'failure.png') }).catch(() => {});
} finally {
  if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await writeFile(join(scratch, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
