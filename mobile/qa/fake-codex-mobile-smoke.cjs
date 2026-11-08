// Offline app-server used only by native-host-smoke.mjs. It is intentionally
// small: discovery, connect and one send are enough to prove the mobile native
// client reaches the runtime's actual provider boundary.
const { appendFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const log = process.env.THREADTERM_QA_MOBILE_CHAT_LOG;
if (!log) process.exit(2);
if (process.argv.includes('--version') || process.argv.includes('-V') || process.argv.includes('--help')) {
  console.log('codex-cli 0.999.0-mobile-smoke');
  process.exit(0);
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('authenticated mobile smoke fixture');
  process.exit(0);
}
if (!process.argv.includes('app-server')) process.exit(2);
const record = value => appendFileSync(log, `${JSON.stringify(value)}\n`);
let threadId = `mobile-smoke-${randomUUID()}`;
let turn = 0;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (id, value) => send({ id, result: value });
const notice = (method, params) => send({ method, params });
const thread = () => ({ id: threadId, cwd: process.cwd(), status: { type: 'idle' } });
require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/start' || method === 'thread/resume') {
    if (params.threadId) threadId = params.threadId;
    return result(id, { thread: thread(), threadSettings: { model: 'mobile-smoke', approvalPolicy: 'on-request' } });
  }
  if (method === 'thread/read') {
    if (params.threadId) threadId = params.threadId;
    return result(id, { thread: { ...thread(), turns: [] } });
  }
  if (method === 'model/list') return result(id, { data: [{ id: 'mobile-smoke', displayName: 'Mobile smoke', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'thread/settings/update' || method === 'thread/inject_items') return result(id, {});
  if (method === 'turn/start') {
    const turnId = `mobile-smoke-turn-${++turn}`;
    const text = (params.input ?? []).map(item => item.text ?? '').join('');
    record({ method, text, threadId, turnId });
    notice('turn/started', { threadId, turn: { id: turnId } });
    result(id, { turn: { id: turnId } });
    notice('item/completed', { threadId, turnId, item: { id: `${turnId}-answer`, type: 'agentMessage', text: 'MOBILE_NATIVE_CHAT_RECEIVED' } });
    notice('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    return;
  }
  send({ id, error: { code: -32000, message: `unexpected mobile smoke request: ${method}` } });
});
