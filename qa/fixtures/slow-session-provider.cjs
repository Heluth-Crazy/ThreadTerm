// Codex app-server fixture for qa/chat-session-isolation.mjs. Startup delays
// are read per request so an already-ready session remains fast while a later
// session is deliberately connecting.
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { join, resolve } = require('node:path');

const control = process.env.THREADTERM_QA_SLOW_SESSION_CONTROL;
const logPath = process.env.THREADTERM_QA_SLOW_SESSION_LOG;
const defaultCwd = process.env.THREADTERM_QA_SLOW_SESSION_CWD;
const targetCwd = process.env.THREADTERM_QA_SLOW_SESSION_TARGET_CWD;
if (process.argv.includes('--version') || process.argv.includes('-V')) {
  process.stdout.write('codex-cli 0.999.0-qa-session-isolation\n');
  process.exit(0);
}
if (!control || !logPath || !defaultCwd || !targetCwd) process.exit(2);
if (!process.argv.includes('app-server')) process.exit(2);

const instanceId = randomUUID();
const record = (direction, method, detail = {}) => appendFileSync(logPath,
  `${JSON.stringify({ at: Date.now(), monotonicUs: Number(process.hrtime.bigint() / 1000n), pid: process.pid,
    instanceId, direction, method, ...detail })}\n`);
const delayOf = name => {
  const path = join(control, name);
  const value = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
  return Number.isFinite(value) && value >= 0 && value <= 120_000 ? value : 0;
};
const pathKey = value => {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const nativeCwdPath = id => join(control, `cwd-${String(id).replaceAll(/[^A-Za-z0-9._-]/g, '_')}`);
const targetNativePath = join(control, 'target-native-id');
const isTargetRequest = params => pathKey(params.cwd ?? defaultCwd) === pathKey(targetCwd)
  || Boolean(params.threadId && existsSync(targetNativePath)
    && readFileSync(targetNativePath, 'utf8').trim() === params.threadId);
const later = (ms, callback) => ms > 0 ? setTimeout(callback, ms) : callback();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (id, value) => send({ id, result: value });
const event = (method, params) => send({ method, params });

record('fixture', 'started');
let nativeId = `qa-session-isolation-${randomUUID()}`;
let threadCwd = defaultCwd;
let turn = 0;
const thread = () => ({ id: nativeId, cwd: threadCwd, model: 'qa-session-isolation', reasoningEffort: 'medium', status: { type: 'idle' } });

process.stdin.on('end', () => process.exit(0));
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  record('in', method, { requestId: id, threadId: params.threadId, cwd: params.cwd });
  // Initialization and history readers are shared provider infrastructure,
  // not evidence that the target Chat is connecting. Never delay either one.
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/start' || method === 'thread/resume') {
    if (params.threadId) nativeId = params.threadId;
    if (params.cwd) threadCwd = params.cwd;
    else if (existsSync(nativeCwdPath(nativeId))) threadCwd = readFileSync(nativeCwdPath(nativeId), 'utf8').trim();
    const target = isTargetRequest(params);
    if (target) writeFileSync(targetNativePath, nativeId);
    writeFileSync(nativeCwdPath(nativeId), threadCwd);
    const ms = target ? delayOf('thread-ms') : 0;
    record('delay', method, { requestId: id, ms, cwd: threadCwd, nativeId, target });
    return later(ms, () => {
      record('delay_end', method, { requestId: id, ms, cwd: threadCwd, nativeId, target });
      result(id, { thread: thread(), threadSettings: { model: 'qa-session-isolation', approvalPolicy: 'on-request' } });
    });
  }
  // New-chat durability verification opens a second app-server process and
  // reads the exact thread back. Preserve the requested identity there.
  if (method === 'thread/read') {
    if (params.threadId) nativeId = params.threadId;
    if (existsSync(nativeCwdPath(nativeId))) threadCwd = readFileSync(nativeCwdPath(nativeId), 'utf8').trim();
    return result(id, { thread: { ...thread(), turns: [] } });
  }
  if (method === 'model/list') return result(id, { data: [{ id: 'qa-session-isolation', displayName: 'QA session isolation', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'thread/settings/update' || method === 'thread/inject_items' || method === 'turn/interrupt') return result(id, {});
  if (method === 'turn/start') {
    const turnId = `qa-session-isolation-turn-${++turn}`;
    const itemId = `${turnId}-answer`;
    event('turn/started', { threadId: nativeId, turn: { id: turnId } });
    result(id, { turn: { id: turnId } });
    event('item/started', { threadId: nativeId, turnId, item: { id: itemId, type: 'agentMessage' } });
    event('item/agentMessage/delta', { threadId: nativeId, turnId, itemId, delta: 'SESSION-ISOLATION-ANSWER' });
    event('item/completed', { threadId: nativeId, turnId, item: { id: itemId, type: 'agentMessage', text: 'SESSION-ISOLATION-ANSWER' } });
    event('turn/completed', { threadId: nativeId, turn: { id: turnId, status: 'completed' } });
    return;
  }
  send({ id, error: { code: -32000, message: `Unexpected session-isolation QA request: ${method}` } });
});
