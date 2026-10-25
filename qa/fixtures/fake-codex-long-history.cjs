// QA-only Codex app-server for qa/chat-long-history-ui.mjs. It answers the new-Chat
// handshake the runtime sends (pinned by qa/chat-plan-fixture.test.mjs) and then idles:
// no model, no account, no turn. Each process owns a distinct native thread so several
// seeded Chats can connect at once, and an unexpected request is answered with an error
// (and logged) so a runtime change cannot silently change what this harness proves.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const log = process.env.THREADTERM_QA_CODEX_LONG_LOG;
const cwd = process.env.THREADTERM_QA_CODEX_LONG_CWD;
if (!log || !cwd) process.exit(2);
const nativeId = `qa-long-history-${process.pid}`;
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const result = (id, value) => process.stdout.write(`${JSON.stringify({ id, result: value })}\n`);
const error = (id, message) => process.stdout.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
const thread = id => ({ id, cwd, model: 'qa-long-model', reasoningEffort: 'medium', collaborationMode: { mode: 'default' }, status: { type: 'idle' }, turns: [] });
const threadResponse = id => ({ thread: thread(id), threadSettings: { collaborationMode: { mode: 'default' } }, model: 'qa-long-model', reasoningEffort: 'medium' });

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  record(method, params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  // A second app-server process proves it can read back the thread it was asked for.
  if (method === 'thread/start') return result(id, threadResponse(nativeId));
  if (method === 'thread/resume' || method === 'thread/read') return result(id, threadResponse(params.threadId ?? nativeId));
  if (method === 'thread/inject_items') return result(id, {});
  if (method === 'model/list') return result(id, { data: [{ id: 'qa-long-model', displayName: 'QA long model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/settings/update') return result(id, threadResponse(params.threadId ?? nativeId));
  error(id, `unexpected request ${method}`);
});
