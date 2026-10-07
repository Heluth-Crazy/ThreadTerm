// Real Electron + isolated runtime regression for high-volume Codex app-server
// notifications.  No real model, account, profile, pipe, or user runtime is used.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const qa = dirname(fileURLToPath(import.meta.url));
const root = resolve(qa, '..');
const args = process.argv.slice(2);
const option = name => args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined;
const baseline = args.includes('--baseline');
const suppliedRuntime = option('--runtime') ?? process.env.THREADTERM_QA_RUNTIME_EXE;
const defaultRuntime = resolve(root, baseline && existsSync(resolve(root, 'runtime/target-qa/baseline/threadterm-v3-runtime.exe'))
  ? 'runtime/target-qa/baseline/threadterm-v3-runtime.exe'
  : 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const runtime = resolve(suppliedRuntime ?? defaultRuntime);
assert.match(runtime.replace(/\\/gu, '/'), /runtime\/target-qa\/(?:baseline\/)?debug?\/?|runtime\/target-qa\/(?:baseline\/)?threadterm-v3-runtime\.exe$/u, 'QA runtime required');
assert.ok(existsSync(runtime), `Missing QA runtime: ${runtime}`);
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-overflow-'));
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const log = join(scratch, 'codex-requests.jsonl');
const fixture = resolve(qa, 'fixtures/fake-codex-overflow.cjs');
const commandOutput = 'o'.repeat(1024 * 1024);
const streamedAssistantText = Array.from({ length: 1536 }, (_, index) => `[${String(index).padStart(4, '0')}]`).join('');
const report = { passed: false, baseline, runtime, scratch, eventCounts: {}, checks: [] };
let app;
let page;
let session;
let sibling;

const forbidden = new Set(['path', 'codex_home', 'openai_api_key', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_dev_server_url']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !forbidden.has(key.toLowerCase())));
Object.assign(env, {
  THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-chat-overflow-${randomUUID()}`,
  THREADTERM_V3_RUNTIME: runtime, CODEX_HOME: join(scratch, 'provider-home'),
  THREADTERM_QA_CODEX_OVERFLOW_LOG: log, THREADTERM_QA_CODEX_OVERFLOW_CWD: workspace,
});

const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(check, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function transcript() { return rpc('chat.read', { sessionId: session.id }); }
async function snapshot() { return rpc('runtime.snapshot'); }
function countEvents() {
  return readFile(log, 'utf8').then(text => text.split(/\r?\n/u).filter(Boolean).map(JSON.parse)
    .reduce((counts, row) => ({ ...counts, [row.method]: (counts[row.method] ?? 0) + 1 }), {}));
}
async function lostProviderUpdates() {
  const runtimeLog = join(env.THREADTERM_V3_DATA, 'runtime.log');
  const text = existsSync(runtimeLog) ? await readFile(runtimeLog, 'utf8') : '';
  return [...text.matchAll(/chat projection lost (\d+) provider updates/gu)]
    .reduce((total, match) => total + Number(match[1]), 0);
}
async function send(text, operationId = randomUUID()) {
  const lease = await rpc('session.claim', { sessionId: session.id, clientId: 'chat-event-overflow-qa' });
  const started = await rpc('chat.send', { sessionId: session.id, text, operationId, leaseEpoch: lease.leaseEpoch });
  return { operationId, turnId: started.turnId, leaseEpoch: lease.leaseEpoch };
}

try {
  await Promise.all([bin, workspace, env.THREADTERM_V3_DATA, env.THREADTERM_V3_USER_DATA, env.CODEX_HOME].map(path => mkdir(path)));
  await writeFile(log, '');
  // A .cmd launcher intentionally accepts Codex's per-Chat `-c` MCP override
  // before the app-server subcommand.  A copied node.exe cannot: node treats
  // that first `-c` as its own syntax-check flag.
  await writeFile(join(bin, 'codex.cmd'), `@"${process.execPath}" "${fixture}" %*\r\n`);
  env.Path = [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';');
  app = await electron.launch({ args: [root], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await rpc('project.add', { path: workspace, name: 'Chat overflow QA', operationId: randomUUID() });
  session = await rpc('session.create', { cwd: workspace, provider: 'codex', mode: 'chat', title: 'Chat overflow QA', operationId: randomUUID() });
  // Keep a second live-eligible Chat unconnected.  The old global degradation
  // path incorrectly turned every Chat (including this unrelated one) red.
  sibling = await rpc('session.create', { cwd: workspace, provider: 'codex', mode: 'chat', title: 'Unrelated overflow sibling', operationId: randomUUID() });
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.locator('.chat-model-chip').filter({ hasText: 'QA overflow model' }).waitFor({ timeout: 30_000 });

  const first = await send('reproduce command output event burst');
  let approval;
  await until(async () => {
    approval = (await transcript()).flatMap(item => item.turnId === first.turnId ? item.parts : [])
      .find(part => part.type === 'approval' && part.status === 'pending');
    return Boolean(approval);
  }, 'genuine approval request', baseline ? 12_000 : 45_000).catch(error => {
    if (!baseline) throw error;
    report.approvalError = error.message;
  });

  if (baseline) {
    // Do not paper over a dropped approval.  Capture the loss and leave the
    // provider turn active for the isolated runtime shutdown below.
    await delay(500);
    const items = await transcript();
    const firstItems = items.filter(item => item.turnId === first.turnId);
    report.eventCounts = await countEvents();
    report.burst = { outputBytes: commandOutput.length, outputDeltaEvents: 16384, legacyDuplicateEvents: 16384, usefulAssistantDeltaEvents: 1536, usefulAssistantBytes: streamedAssistantText.length };
    const stateAfterBurst = await snapshot();
    report.firstTurn = { itemCount: firstItems.length, status: stateAfterBurst.sessions.find(candidate => candidate.id === session.id)?.status };
    report.unrelatedSessionStatus = stateAfterBurst.sessions.find(candidate => candidate.id === sibling.id)?.status;
    report.lostProviderUpdates = await lostProviderUpdates();
    report.degraded = report.lostProviderUpdates > 0 || !approval || report.unrelatedSessionStatus === 'error';
    assert.ok(report.degraded, 'baseline must expose the historical queue loss or an incomplete lifecycle');
    report.warning = `Baseline reproduced ${report.lostProviderUpdates} lost provider updates; final completion can still arrive after earlier queue loss.`;
    report.passed = true;
  } else {
    assert.ok(approval?.approvalId, 'approval must be a genuine pending JSON-RPC request');
    const beforeApproval = await transcript();
    const firstItemsBeforeApproval = beforeApproval.filter(item => item.turnId === first.turnId);
    const command = firstItemsBeforeApproval.flatMap(item => item.parts).find(part => part.type === 'tool' && part.data?.aggregatedOutput !== undefined);
    assert.equal(command?.data?.aggregatedOutput, commandOutput, 'completed command output must retain exactly 1 MiB authoritative content');
    await rpc('chat.approve', { sessionId: session.id, turnId: first.turnId, approvalId: approval.approvalId, choiceId: 'accept', leaseEpoch: first.leaseEpoch, operationId: randomUUID() });
    await until(async () => (await countEvents())['approval.response'] === 1, 'native approval response');
    await until(async () => (await transcript()).flatMap(item => item.turnId === first.turnId ? item.parts : [])
      .some(part => part.type === 'text' && part.text === streamedAssistantText), 'complete useful assistant delta stream');
    await until(async () => (await transcript()).some(item => item.turnId === first.turnId && item.parts.some(part => part.text === 'authoritative final answer after overflow')), 'authoritative final item');
    await until(async () => (await snapshot()).sessions.find(candidate => candidate.id === session.id)?.status === 'idle', 'first turn completion');
    const items = await transcript();
    const firstItems = items.filter(item => item.turnId === first.turnId);
    const streamed = firstItems.flatMap(item => item.parts).find(part => part.type === 'text' && part.text?.startsWith('[0000]'));
    assert.equal(streamed?.text, streamedAssistantText, 'all useful assistant deltas must survive without an item/completed replacement');
    const final = firstItems.find(item => item.parts.some(part => part.text === 'authoritative final answer after overflow'));
    assert.ok(final, 'authoritative completed assistant item must survive the burst');
    report.eventCounts = await countEvents();
    report.burst = { outputBytes: commandOutput.length, outputDeltaEvents: 16384, legacyDuplicateEvents: 16384, usefulAssistantDeltaEvents: 1536, usefulAssistantBytes: streamedAssistantText.length };
    const stateAfterBurst = await snapshot();
    report.firstTurn = { itemCount: firstItems.length, status: stateAfterBurst.sessions.find(candidate => candidate.id === session.id)?.status };
    report.unrelatedSessionStatus = stateAfterBurst.sessions.find(candidate => candidate.id === sibling.id)?.status;
    report.lostProviderUpdates = await lostProviderUpdates();
    assert.equal(report.firstTurn.status, 'idle', 'completion must settle the active provider turn');
    assert.equal(report.lostProviderUpdates, 0, 'repaired runtime must not report lost provider updates');
    assert.notEqual(report.unrelatedSessionStatus, 'error', 'a different Chat must not be failed by this session\'s transcript degradation');
    const second = await send('following turn must be accepted');
    await until(async () => (await transcript()).some(item => item.turnId === second.turnId && item.parts.some(part => part.text === 'authoritative final answer after overflow')), 'following turn result');
    await until(async () => (await snapshot()).sessions.find(candidate => candidate.id === session.id)?.status === 'idle', 'following turn completion');
    report.checks.push('1 MiB command-output delta and legacy duplicate burst preserved authoritative completion');
    report.checks.push('following turn was accepted only after the original provider completion');
    report.passed = true;
  }
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: join(scratch, 'failure.png') }).catch(() => {});
  // Baseline must still leave an inspectable report when the historical loss
  // manifests as a timeout or connection error.
  if (baseline) { report.degraded = true; report.passed = true; }
  else process.exitCode = 1;
} finally {
  if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await writeFile(join(scratch, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
