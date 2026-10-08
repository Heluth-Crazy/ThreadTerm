// Deterministic reconnect fixture. It never contacts Codex or a model.
const { appendFileSync, existsSync } = require('node:fs');
const { createInterface } = require('node:readline');

const log = process.env.THREADTERM_QA_CODEX_RECONNECT_LOG;
const cwd = process.env.THREADTERM_QA_CODEX_RECONNECT_CWD;
const control = process.env.THREADTERM_QA_CODEX_RECONNECT_CONTROL;
if (!log || !cwd || !control) process.exit(2);

const nativeId = 'qa-codex-reconnect-thread';
let turn = 0;
let model = 'qa-reconnect-a';
const record = (direction, method, params) => appendFileSync(log, `${JSON.stringify({ at: Date.now(), direction, method, params })}\n`);
const send = value => { record('out', value.method ?? 'response', value.params ?? value); process.stdout.write(`${JSON.stringify(value)}\n`); };
const result = (id, value) => send({ id, result: value });
const event = (method, params) => send({ method, params });
const thread = () => ({ id: nativeId, cwd, model, reasoningEffort: 'medium', status: { type: 'idle' } });
const response = () => ({ thread: thread(), threadSettings: { model, approvalPolicy: 'on-request' } });

function gap(nativeTurn) {
  const command = `${nativeTurn}-tool`;
  event('item/started', { threadId: nativeId, turnId: nativeTurn, item: { id: command, type: 'commandExecution', command: 'echo GAP-TOOL' } });
  event('item/completed', { threadId: nativeId, turnId: nativeTurn, item: { id: command, type: 'commandExecution', status: 'completed', command: 'echo GAP-TOOL', aggregatedOutput: 'GAP-TOOL-OUTPUT' } });
  model = 'qa-reconnect-b';
  event('serverRequest/resolved', { threadId: nativeId, turnId: nativeTurn, requestId: 'qa-reconnect-approval' });
  event('thread/settings/updated', { threadId: nativeId, threadSettings: { model } });
  const assistant = `${nativeTurn}-assistant`;
  event('item/started', { threadId: nativeId, turnId: nativeTurn, item: { id: assistant, type: 'agentMessage' } });
  event('item/agentMessage/delta', { threadId: nativeId, turnId: nativeTurn, itemId: assistant, delta: 'GAP-FINAL-ANSWER' });
  event('item/completed', { threadId: nativeId, turnId: nativeTurn, item: { id: assistant, type: 'agentMessage', text: 'GAP-FINAL-ANSWER' } });
  event('turn/completed', { threadId: nativeId, turn: { id: nativeTurn, status: 'completed' } });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  record('in', method, params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/start' || method === 'thread/resume') return result(id, response());
  if (method === 'thread/read') return result(id, { thread: thread() });
  if (method === 'model/list') return result(id, { data: [
    { id: 'qa-reconnect-a', displayName: 'QA reconnect A', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
    { id: 'qa-reconnect-b', displayName: 'QA reconnect B', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
  ] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'thread/settings/update') {
    if (params.model === 'qa-reconnect-a' || params.model === 'qa-reconnect-b') model = params.model;
    result(id, {});
    event('thread/settings/updated', { threadId: nativeId, threadSettings: { model, effort: params.effort ?? 'medium' } });
    return;
  }
  if (method === 'turn/start') {
    const nativeTurn = `qa-reconnect-turn-${++turn}`;
    event('turn/started', { threadId: nativeId, turn: { id: nativeTurn } });
    result(id, { turn: { id: nativeTurn } });
    const before = `${nativeTurn}-before`;
    event('item/started', { threadId: nativeId, turnId: nativeTurn, item: { id: before, type: 'agentMessage' } });
    event('item/agentMessage/delta', { threadId: nativeId, turnId: nativeTurn, itemId: before, delta: 'BEFORE-CONTROL-DROP' });
    event('item/completed', { threadId: nativeId, turnId: nativeTurn, item: { id: before, type: 'agentMessage', text: 'BEFORE-CONTROL-DROP' } });
    // This approval is visible before the desktop pipe is cut. The staged release
    // resolves it, changes the model and completes the turn while reconnect is paused.
    send({ id: 'qa-reconnect-approval', method: 'item/commandExecution/requestApproval', params: { threadId: nativeId, turnId: nativeTurn, command: 'echo GAP-APPROVAL' } });
    const release = `${control}\\release`;
    const waitForRelease = () => { if (existsSync(release)) gap(nativeTurn); else setTimeout(waitForRelease, 25); };
    waitForRelease();
    return;
  }
  if (method === 'turn/interrupt') {
    event('turn/completed', { threadId: nativeId, turn: { id: params.turnId, status: 'interrupted' } });
    return result(id, {});
  }
  send({ id, error: { code: -32000, message: `Unexpected QA request: ${method}` } });
});
