// Deterministic QA-only Codex app-server.  It deliberately reproduces the
// historical command-output notification fan-out without using a model/account.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const log = process.env.THREADTERM_QA_CODEX_OVERFLOW_LOG;
if (!log) process.exit(2);
const cwd = process.env.THREADTERM_QA_CODEX_OVERFLOW_CWD;
const nativeId = 'qa-codex-overflow-thread';
const outputSize = 1024 * 1024;
const chunkSize = 64;
const output = 'o'.repeat(outputSize);
const streamedChunks = Array.from({ length: 1536 }, (_, index) => `[${String(index).padStart(4, '0')}]`);
const streamedText = streamedChunks.join('');
const approvalRequestId = 'qa-overflow-approval-1';
let turn = 0;
let pendingApproval;
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id, value) => send({ id, result: value });
const event = (method, params) => send({ method, params });
const thread = () => ({ id: nativeId, cwd, status: { type: 'idle' } });
const response = () => ({ thread: thread(), threadSettings: { model: 'qa-overflow-model', approvalPolicy: 'on-request' } });

function commandBurst(nativeTurn) {
  const itemId = `${nativeTurn}-command`;
  event('item/started', { threadId: nativeId, turnId: nativeTurn, item: { id: itemId, type: 'commandExecution', command: 'qa-overflow' } });
  for (let offset = 0; offset < output.length; offset += chunkSize) {
    const delta = output.slice(offset, offset + chunkSize);
    // Current app-server notification.  It is non-semantic until the final
    // item/completed payload, and used to be projected as provider.event.
    event('item/commandExecution/outputDelta', { threadId: nativeId, turnId: nativeTurn, itemId, delta });
    // Legacy Codex carries the same notification below codex/event.  Keep the
    // payload explicit so a boundary normalizer can discard only this duplicate.
    event('codex/event/exec_command_output_delta', { event: { method: 'item/commandExecution/outputDelta', params: { threadId: nativeId, turnId: nativeTurn, itemId, delta } } });
  }
  event('item/completed', { threadId: nativeId, turnId: nativeTurn, item: { id: itemId, type: 'commandExecution', status: 'completed', command: 'qa-overflow', aggregatedOutput: output } });
}

function finishTurn(nativeTurn) {
  const streamingItemId = `${nativeTurn}-streaming`;
  event('item/started', { threadId: nativeId, turnId: nativeTurn, item: { id: streamingItemId, type: 'agentMessage' } });
  // These are useful transcript deltas, deliberately more than the old 1024
  // queue capacity.  There is no item/completed text for this item: the
  // harness checks that projection retained the actual concatenation.
  for (const delta of streamedChunks) event('item/agentMessage/delta', { threadId: nativeId, turnId: nativeTurn, itemId: streamingItemId, delta });
  const messageId = `${nativeTurn}-assistant`;
  event('item/started', { threadId: nativeId, turnId: nativeTurn, item: { id: messageId, type: 'agentMessage' } });
  event('item/agentMessage/delta', { threadId: nativeId, turnId: nativeTurn, itemId: messageId, delta: 'a'.repeat(4096) });
  event('item/completed', { threadId: nativeId, turnId: nativeTurn, item: { id: messageId, type: 'agentMessage', text: 'authoritative final answer after overflow' } });
  event('turn/completed', { threadId: nativeId, turn: { id: nativeTurn, status: 'completed' } });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === approvalRequestId && !request.method && pendingApproval) {
    record('approval.response', request.result);
    const { nativeTurn } = pendingApproval;
    pendingApproval = undefined;
    event('serverRequest/resolved', { threadId: nativeId, turnId: nativeTurn, requestId: approvalRequestId });
    finishTurn(nativeTurn);
    return;
  }
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  record(method, params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/start' || method === 'thread/resume') return result(id, response());
  if (method === 'thread/read') return result(id, { thread: thread() });
  if (method === 'model/list') return result(id, { data: [{ id: 'qa-overflow-model', displayName: 'QA overflow model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'turn/start') {
    const nativeTurn = `qa-overflow-turn-${++turn}`;
    event('turn/started', { threadId: nativeId, turn: { id: nativeTurn } });
    result(id, { turn: { id: nativeTurn } });
    if (turn === 1) {
      commandBurst(nativeTurn);
      // A genuine server request is deliberately between tool completion and
      // assistant final.  The fixture waits for Chat's JSON-RPC response.
      pendingApproval = { nativeTurn };
      send({ id: approvalRequestId, method: 'item/commandExecution/requestApproval', params: { threadId: nativeId, turnId: nativeTurn, command: 'echo approval-after-output' } });
      return;
    }
    finishTurn(nativeTurn);
    return;
  }
  if (method === 'turn/interrupt') {
    event('turn/completed', { threadId: nativeId, turn: { id: params.turnId, status: 'interrupted' } });
    return result(id, {});
  }
  send({ id, error: { code: -32000, message: `Unexpected QA request: ${method}` } });
});
