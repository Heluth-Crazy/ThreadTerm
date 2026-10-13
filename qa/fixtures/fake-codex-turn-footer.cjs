// Deterministic Codex app-server fixture for F1. It edits exactly three files
// after the runtime has captured the before-turn checkpoint; it never invokes
// a provider executable or starts a model turn outside this fake protocol.
const { appendFileSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const cwd = process.env.THREADTERM_QA_TURN_FOOTER_CWD;
const log = process.env.THREADTERM_QA_TURN_FOOTER_LOG;
if (!cwd || !log) process.exit(2);
const threadId = 'qa-turn-footer-thread';
let serial = 0;
const record = (direction, method, params) => appendFileSync(log, `${JSON.stringify({ direction, method, params })}\n`);
const send = value => { record('out', value.method ?? 'response', value.params ?? value); process.stdout.write(`${JSON.stringify(value)}\n`); };
const result = (id, value) => send({ id, result: value });
const event = (method, params) => send({ method, params });
const thread = () => ({ id: threadId, cwd, model: 'qa-turn-footer-model', status: { type: 'idle' } });

function editThreeFiles() {
  writeFileSync(`${cwd}/src/edited.ts`, 'export const edited = true;\n');
  mkdirSync(`${cwd}/src/new`, { recursive: true });
  writeFileSync(`${cwd}/src/new/added.ts`, 'export const added = true;\n');
  rmSync(`${cwd}/src/deleted.ts`, { force: true });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line); if (request.id === undefined) return;
  const { id, method, params = {} } = request; record('in', method, params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/start' || method === 'thread/resume') return result(id, { thread: thread(), threadSettings: { model: 'qa-turn-footer-model', approvalPolicy: 'on-request' } });
  if (method === 'thread/read') return result(id, { thread: thread() });
  if (method === 'model/list') return result(id, { data: [{ id: 'qa-turn-footer-model', displayName: 'QA footer model', supportedReasoningEfforts: [] }] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'turn/start') {
    const turnId = `qa-turn-footer-turn-${++serial}`;
    event('turn/started', { threadId, turn: { id: turnId } }); result(id, { turn: { id: turnId } });
    const finish = () => { editThreeFiles(); event('item/completed', { threadId, turnId, item: { id: `${turnId}-answer`, type: 'agentMessage', phase: 'final_answer', text: 'Footer fixture edited three files.' } }); event('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { inputTokens: 12345, outputTokens: 2100, cachedInputTokens: 40000, totalTokens: 54445 }, total: { totalTokens: 54445 } } }); event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }); };
    if (String(params.input?.[0]?.text ?? '').includes('slow')) setTimeout(finish, 1_500); else finish();
    return;
  }
  if (method === 'turn/interrupt') { event('turn/completed', { threadId, turn: { id: params.turnId, status: 'interrupted' } }); return result(id, {}); }
  send({ id, error: { code: -32000, message: `Unexpected F1 fixture request: ${method}` } });
});
