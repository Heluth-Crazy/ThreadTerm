// QA-only Codex app-server for the C2 composer chips. It never connects to a
// model or user account: it advertises a 12-model catalog with service tiers
// and echoes thread/settings/update back through thread/settings/updated so the
// option chips can round-trip in the real app.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const log = process.env.THREADTERM_QA_CODEX_COMPOSER_LOG;
if (!log) process.exit(2);
const nativeId = 'qa-codex-composer-thread';
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const result = (id, value) => process.stdout.write(`${JSON.stringify({ id, result: value })}\n`);
const error = (id, message) => process.stdout.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
const event = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);

const MODELS = [];
for (const prefix of ['openai', 'anthropic']) {
  for (const suffix of ['a', 'b', 'c', 'd', 'e', 'f']) {
    MODELS.push({
      id: `${prefix}/qa-${suffix}`,
      displayName: `${prefix === 'openai' ? 'GPT' : 'Claude'} QA ${suffix.toUpperCase()}`,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
      serviceTiers: [{ id: 'flex' }, { id: 'priority' }],
      defaultServiceTier: 'flex',
      ...(prefix === 'openai' && suffix === 'a' ? { isDefault: true } : {}),
    });
  }
}

const settings = {
  model: 'openai/qa-a',
  reasoningEffort: 'medium',
  collaborationMode: { mode: 'default', settings: { model: 'openai/qa-a', reasoning_effort: 'medium' } },
  approvalPolicy: 'on-request',
  sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: [] },
  serviceTier: null,
  approvalsReviewer: 'user',
};

const thread = () => ({ id: nativeId, cwd: process.env.THREADTERM_QA_CODEX_COMPOSER_CWD, ...settings });
const threadResponse = () => ({ thread: thread(), threadSettings: settings, model: settings.model, reasoningEffort: settings.reasoningEffort });

function apply(params) {
  if (typeof params.model === 'string') settings.model = params.model;
  if (typeof params.effort === 'string') { settings.effort = params.effort; settings.reasoningEffort = params.effort; }
  if (params.collaborationMode && typeof params.collaborationMode === 'object') settings.collaborationMode = params.collaborationMode;
  if (typeof params.approvalPolicy === 'string') settings.approvalPolicy = params.approvalPolicy;
  if (params.sandboxPolicy && typeof params.sandboxPolicy === 'object') settings.sandboxPolicy = params.sandboxPolicy;
  if ('serviceTier' in params) settings.serviceTier = params.serviceTier;
  if (typeof params.approvalsReviewer === 'string') settings.approvalsReviewer = params.approvalsReviewer;
}

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
  if (method === 'thread/settings/update') {
    apply(params);
    event('thread/settings/updated', { threadId: nativeId, threadSettings: settings });
    return result(id, { threadSettings: settings });
  }
  if (method === 'thread/tokenUsage/updated') return result(id, {});
  if (method === 'turn/start') {
    event('turn/completed', { threadId: nativeId, turn: { id: 'qa-composer-turn', status: 'completed' } });
    return result(id, { turn: { id: 'qa-composer-turn' } });
  }
  if (method === 'turn/interrupt') return result(id, {});
  return error(id, `Unexpected QA request: ${method}`);
});
