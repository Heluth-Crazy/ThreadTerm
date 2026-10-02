// Isolated app-server mirror for Codex 0.159.1 compatibility QA; never contacts a model.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const log = process.env.THREADTERM_QA_CODEX_COMPAT_LOG;
if (!log) process.exit(2);
let model = 'qa-model-a', collaboration = 'default', approvalPolicy = 'on-request', sandbox = { type: 'workspaceWrite', networkAccess: false, writableRoots: [] }, turn = 0;
const nativeId = 'qa-codex-compat-thread';
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const result = (id, value) => process.stdout.write(`${JSON.stringify({ id, result: value })}\n`);
const error = (id, message, code = -32000) => process.stdout.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
const event = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
const thread = () => ({ id: nativeId, cwd: process.env.THREADTERM_QA_CODEX_COMPAT_CWD, status: { type: 'idle' } });
const settings = () => ({ model, effort: 'medium', approvalPolicy, sandboxPolicy: sandbox, collaborationMode: { mode: collaboration } });
const response = () => ({ thread: thread(), threadSettings: settings() });
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line); if (request.id === undefined) return;
  const { id, method, params = {} } = request; record(method, params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/start' || method === 'thread/resume') return result(id, response());
  if (method === 'thread/read') return result(id, { thread: thread() });
  if (method === 'model/list') return result(id, { data: [{ id: 'qa-model-a', displayName: 'QA Model A', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }, { id: 'qa-model-b', displayName: 'QA Model B', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] });
  if (method === 'skills/list') return result(id, { data: [{ cwd: process.env.THREADTERM_QA_CODEX_COMPAT_CWD, skills: [{ name: 'qa-skill', path: 'C:/qa/SKILL.md', description: 'QA skill', enabled: true }], errors: [] }] });
  if (method === 'thread/settings/update') {
    if (params.model === 'qa-unsupported') return error(id, 'unknown variant `thread/settings/update`', -32600);
    if (params.model === 'qa-rejected') return error(id, 'QA model rejected');
    if (params.model === 'qa-unconfirmed') return result(id, {});
    if (params.model) model = params.model; if (params.approvalPolicy) approvalPolicy = params.approvalPolicy; if (params.sandboxPolicy) sandbox = params.sandboxPolicy; if (params.collaborationMode?.mode) collaboration = params.collaborationMode.mode;
    event('thread/settings/updated', { threadId: nativeId, threadSettings: settings() }); return result(id, {});
  }
  if (method === 'thread/compact/start' || method === 'review/start') { const id2 = `qa-native-turn-${++turn}`; event('turn/started', { threadId: nativeId, turn: { id: id2 } }); result(id, { turn: { id: id2 } }); event('turn/completed', { threadId: nativeId, turn: { id: id2, status: 'completed' } }); return; }
  if (method === 'turn/start') { const id2 = `qa-turn-${++turn}`; event('turn/started', { threadId: nativeId, turn: { id: id2 } }); result(id, { turn: { id: id2 } }); if (params.input?.some(item => item.type === 'skill')) event('turn/completed', { threadId: nativeId, turn: { id: id2, status: 'completed' } }); return; }
  if (method === 'turn/interrupt') { event('turn/completed', { threadId: nativeId, turn: { id: params.turnId, status: 'interrupted' } }); return result(id, {}); }
  error(id, `Unexpected QA request: ${method}`);
});
