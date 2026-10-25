// QA-only Codex app-server modelling an older CLI (0.159-era) for the
// portability path in runtime/src/providers/codex.rs: `thread/inject_items` is
// method-not-found and `thread/read` answers without the optional turns array.
// A Chat must still connect, show one non-blocking notice, and run a turn.
// It never connects to a model or account.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const log = process.env.THREADTERM_QA_CODEX_OLD_CLI_LOG;
if (!log) process.exit(2);
const nativeId = 'qa-codex-old-cli-thread';
const version = '0.159.1';
let turn = 0;
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const result = (id, value) => process.stdout.write(`${JSON.stringify({ id, result: value })}\n`);
const error = (id, message, code = -32000) => process.stdout.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
const event = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
// Metadata only: this app-server never returns saved turns.
const thread = () => ({ id: nativeId, cwd: process.env.THREADTERM_QA_CODEX_OLD_CLI_CWD, model: 'qa-model-a', reasoningEffort: 'medium', collaborationMode: { mode: 'default' }, status: { type: 'idle' } });
const threadResponse = () => ({ thread: thread(), threadSettings: { collaborationMode: { mode: 'default' } }, model: 'qa-model-a', reasoningEffort: 'medium' });

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  record(method, params);
  if (method === 'initialize') return result(id, { capabilities: {}, userAgent: `codex_cli_rs/${version} (qa old-cli fixture)` });
  if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/read') return result(id, threadResponse());
  if (method === 'thread/inject_items') return error(id, 'Method not found', -32601);
  if (method === 'model/list') return result(id, { data: [
    { id: 'qa-model-a', displayName: 'QA Model A', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
  ] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/settings/update') return result(id, threadResponse());
  if (method === 'turn/start') {
    const nativeTurn = `qa-old-cli-turn-${++turn}`;
    event('turn/started', { threadId: nativeId, turn: { id: nativeTurn } });
    result(id, { turn: { id: nativeTurn } });
    event('item/completed', { threadId: nativeId, turnId: nativeTurn, item: { id: 'qa-old-cli-answer', type: 'agentMessage', phase: 'final_answer', text: 'The old CLI answered.' + (process.env.THREADTERM_QA_CODEX_OLD_CLI_IMAGE ? `\n\n![QA image](${process.env.THREADTERM_QA_CODEX_OLD_CLI_IMAGE})` : '') } });
    event('turn/completed', { threadId: nativeId, turn: { id: nativeTurn, status: 'completed' } });
    return;
  }
  if (method === 'turn/interrupt') {
    event('turn/completed', { threadId: nativeId, turn: { id: params.turnId, status: 'interrupted' } });
    return result(id, {});
  }
  return error(id, `Unexpected QA request: ${method}`);
});
