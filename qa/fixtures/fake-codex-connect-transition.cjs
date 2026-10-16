// Isolated transition probe only. No provider binaries or network are used.
const { appendFileSync, existsSync, readFileSync, unlinkSync, watch } = require('node:fs');
const { createInterface } = require('node:readline');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const control = process.env.THREADTERM_QA_TRANSITION_CONTROL;
const log = process.env.THREADTERM_QA_TRANSITION_LOG;
const cwd = process.env.THREADTERM_QA_TRANSITION_CWD;
if (!control || !log || !cwd) process.exit(2);
if (process.argv.includes('--version') || process.argv.includes('-V')) { console.log('codex-cli 0.999.0-qa-transition'); process.exit(0); }
if (!process.argv.includes('app-server')) process.exit(2);
const record = (direction, method, params) => appendFileSync(log, `${JSON.stringify({ at: Date.now(), pid: process.pid, direction, method, params })}\n`);
record('fixture', 'started', {});
let nativeId = `qa-transition-${randomUUID()}`;
let turn = 0;
const send = value => { record('out', value.method ?? 'response', value.params ?? value); process.stdout.write(`${JSON.stringify(value)}\n`); };
const result = (id, value) => send({ id, result: value });
const event = (method, params) => send({ method, params });
const thread = () => ({ id: nativeId, cwd, model: 'qa-transition', reasoningEffort: 'medium', status: { type: 'idle' } });
// Only a harness-owned, PID-specific marker can kill this fake. watch is fixture-only.
const crash = () => { if (existsSync(join(control, `crash-${process.pid}`))) { record('fixture', 'crashed', { nativeId }); process.exit(23); } };
const watcher = watch(control, crash);
process.stdin.on('end', () => { watcher.close(); process.exit(0); });
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  record('in', method, params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/start' || method === 'thread/resume') {
    if (params.threadId) nativeId = params.threadId;
    const fail = join(control, `fail-${nativeId}`);
    if (existsSync(fail)) { unlinkSync(fail); return send({ id, error: { code: -32000, message: 'QA requested one failed connect' } }); }
    const delayFile = join(control, 'connect-delay-ms');
    const milliseconds = existsSync(delayFile) ? Number(readFileSync(delayFile, 'utf8')) : 2200;
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 10_000) process.exit(2);
    return setTimeout(() => result(id, { thread: thread(), threadSettings: { model: 'qa-transition', approvalPolicy: 'on-request' } }), milliseconds);
  }
  // New-chat verification reads the thread through a second app-server process: answer with the requested ID.
  if (method === 'thread/read') { if (params.threadId) nativeId = params.threadId; return result(id, { thread: { ...thread(), turns: [] } }); }
  if (method === 'model/list') return result(id, { data: [{ id: 'qa-transition', displayName: 'QA transition', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'thread/settings/update' || method === 'thread/inject_items') return result(id, {});
  if (method === 'turn/start') {
    const turnId = `qa-transition-turn-${++turn}`, itemId = `${turnId}-answer`;
    event('turn/started', { threadId: nativeId, turn: { id: turnId } });
    result(id, { turn: { id: turnId } });
    event('item/started', { threadId: nativeId, turnId, item: { id: itemId, type: 'agentMessage' } });
    event('item/agentMessage/delta', { threadId: nativeId, turnId, itemId, delta: 'TRANSITION-SAVED-ANSWER' });
    event('item/completed', { threadId: nativeId, turnId, item: { id: itemId, type: 'agentMessage', text: 'TRANSITION-SAVED-ANSWER' } });
    event('turn/completed', { threadId: nativeId, turn: { id: turnId, status: 'completed' } });
    return;
  }
  send({ id, error: { code: -32000, message: `Unexpected transition QA request: ${method}` } });
});
