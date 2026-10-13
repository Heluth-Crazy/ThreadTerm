// QA-only Codex app-server for D4. It answers the startup handshake, starts one
// turn, and leaves that turn running so chat.steer can call turn/steer.
// A text item "reject-me" fails with an expectedTurnId mismatch. It never
// connects to a model or account, and it never emits turn/completed.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

if (process.argv.includes('--version') && !process.argv.includes('app-server')) {
  console.log('codex 0.161.0');
  process.exit(0);
}
const log = process.env.THREADTERM_QA_STEER_CODEX_LOG;
if (!log) process.exit(2);
const nativeId = 'qa-codex-steer-thread';
const nativeTurn = 'native-steer-turn';
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const result = (id, value) => process.stdout.write(`${JSON.stringify({ id, result: value })}\n`);
const error = (id, message) => process.stdout.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
const event = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
const MODELS = [
  { id: 'openai/qa-steer', displayName: 'GPT QA Steer', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], serviceTiers: [{ id: 'flex' }], defaultServiceTier: 'flex', isDefault: true },
];
const settings = {
  model: 'openai/qa-steer',
  reasoningEffort: 'medium',
  collaborationMode: { mode: 'default', settings: { model: 'openai/qa-steer', reasoning_effort: 'medium' } },
  approvalPolicy: 'on-request',
  sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: [] },
  serviceTier: null,
  approvalsReviewer: 'user',
};
const thread = () => ({ id: nativeId, cwd: process.env.THREADTERM_QA_STEER_CWD, ...settings });
const threadResponse = () => ({ thread: thread(), threadSettings: settings, model: settings.model, reasoningEffort: settings.reasoningEffort });

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  record(method, params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/read') return result(id, threadResponse());
  if (method === 'model/list') return result(id, { data: MODELS });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/settings/update') return result(id, { threadSettings: settings });
  if (method === 'turn/start') {
    event('turn/started', { threadId: nativeId, turn: { id: nativeTurn } });
    event('item/agentMessage/delta', { threadId: nativeId, turnId: nativeTurn, itemId: 'assistant-1', delta: 'Working' });
    return result(id, { turn: { id: nativeTurn } });
  }
  if (method === 'turn/steer') {
    const text = (params.input ?? []).find(item => item && item.type === 'text')?.text ?? '';
    if (text === 'reject-me') return error(id, 'expectedTurnId does not match the active turn');
    return result(id, { turnId: params.expectedTurnId });
  }
  if (method === 'turn/interrupt') return result(id, {});
  return error(id, `Unexpected QA request: ${method}`);
});
