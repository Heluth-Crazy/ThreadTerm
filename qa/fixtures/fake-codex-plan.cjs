// QA-only Codex app-server for the B4 agent-plan panel. It never connects to a
// model or user account: one turn emits a plan update, a short answer and a
// completion.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const log = process.env.THREADTERM_QA_CODEX_PLAN_LOG;
if (!log) process.exit(2);
const nativeId = 'qa-codex-plan-thread';
let turn = 0;
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const result = (id, value) => process.stdout.write(`${JSON.stringify({ id, result: value })}\n`);
const error = (id, message) => process.stdout.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
const event = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
const thread = () => ({ id: nativeId, cwd: process.env.THREADTERM_QA_CODEX_PLAN_CWD, model: 'qa-model-a', reasoningEffort: 'medium', collaborationMode: { mode: 'default' }, status: { type: 'idle' } });
const threadResponse = () => ({ thread: thread(), threadSettings: { collaborationMode: { mode: 'default' } }, model: 'qa-model-a', reasoningEffort: 'medium' });

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  record(method, params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/read') return result(id, threadResponse());
  if (method === 'model/list') return result(id, { data: [
    { id: 'qa-model-a', displayName: 'QA Model A', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
  ] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/settings/update') return result(id, threadResponse());
  if (method === 'turn/start') {
    const nativeTurn = `qa-native-turn-${++turn}`;
    event('turn/started', { threadId: nativeId, turn: { id: nativeTurn } });
    result(id, { turn: { id: nativeTurn } });
    event('turn/plan/updated', { threadId: nativeId, turnId: nativeTurn, explanation: 'The agent wrote this plan before editing.', plan: [
      { step: 'Map the existing chat projection', status: 'completed' },
      { step: 'Add the additive plan part to every adapter', status: 'inProgress' },
      { step: 'Build the pinned plan panel', status: 'pending' },
    ] });
    event('item/completed', { threadId: nativeId, item: { id: 'qa-plan-answer', type: 'agentMessage', text: 'Still working.' } });
    event('turn/completed', { threadId: nativeId, turn: { id: nativeTurn, status: 'completed' } });
    return;
  }
  if (method === 'turn/interrupt') {
    event('turn/completed', { threadId: nativeId, turn: { id: params.turnId, status: 'interrupted' } });
    return result(id, {});
  }
  return error(id, `Unexpected QA request: ${method}`);
});
