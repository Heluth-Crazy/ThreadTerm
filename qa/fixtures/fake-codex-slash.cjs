// QA-only Codex app-server. It never connects to a model or user account.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const log = process.env.THREADTERM_QA_CODEX_SLASH_LOG;
if (!log) process.exit(2);
let model = 'qa-model-a';
let mode = 'default';
let turn = 0;
const nativeId = 'qa-codex-slash-thread';
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const result = (id, value) => process.stdout.write(`${JSON.stringify({ id, result: value })}\n`);
const error = (id, message) => process.stdout.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
const event = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
const thread = () => ({ id: nativeId, cwd: process.env.THREADTERM_QA_CODEX_SLASH_CWD, model, reasoningEffort: 'medium', collaborationMode: { mode }, status: { type: 'idle' } });
const threadResponse = () => ({ thread: thread(), threadSettings: { collaborationMode: { mode } }, model, reasoningEffort: 'medium' });

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
    { id: 'qa-model-b', displayName: 'QA Model B', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
  ] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/settings/update') {
    if (params.model === 'qa-rejected') return error(id, 'QA model rejected');
    if (params.model) model = params.model;
    if (params.collaborationMode?.mode) mode = params.collaborationMode.mode;
    return result(id, threadResponse());
  }
  if (method === 'turn/start') {
    if (params.input?.some(item => item.text === 'qa fail ordinary turn')) return error(id, 'QA ordinary turn failed');
    const nativeTurn = `qa-native-turn-${++turn}`;
    event('turn/started', { threadId: nativeId, turn: { id: nativeTurn } });
    result(id, { turn: { id: nativeTurn } });
    // Hold this turn until interrupted. The test can assert conflicting local
    // commands do not finish it; no model is contacted.
    return;
  }
  if (method === 'turn/interrupt') {
    event('turn/completed', { threadId: nativeId, turn: { id: params.turnId, status: 'interrupted' } });
    return result(id, {});
  }
  return error(id, `Unexpected QA request: ${method}`);
});
