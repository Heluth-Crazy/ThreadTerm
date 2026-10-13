// QA-only Codex app-server for D2. It is deterministic and never contacts a
// model or account. In plan mode it emits one authoritative completed plan.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

// This fixture never spawns a provider, but make the isolation invariant
// explicit so a future helper cannot accidentally inherit a real CLI PATH.
for (const key of Object.keys(process.env)) if (key.toLowerCase() === 'path') delete process.env[key];

const log = process.env.THREADTERM_QA_CODEX_PLAN_APPROVAL_LOG;
if (!log) process.exit(2);
let collaboration = 'plan';
let turn = 0;
const nativeId = 'qa-codex-plan-approval-thread';
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const result = (id, value) => process.stdout.write(`${JSON.stringify({ id, result: value })}\n`);
const event = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
const thread = () => ({ id: nativeId, cwd: process.env.THREADTERM_QA_CODEX_PLAN_APPROVAL_CWD, model: 'qa-model', reasoningEffort: 'medium', collaborationMode: { mode: collaboration }, status: { type: 'idle' } });
const threadResponse = () => ({ thread: thread(), threadSettings: { collaborationMode: { mode: collaboration } }, model: 'qa-model', reasoningEffort: 'medium' });

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
 if (!line.trim()) return;
 const request = JSON.parse(line); if (request.id === undefined) return;
 const { id, method, params = {} } = request; record(method, params);
 if (method === 'initialize') return result(id, { capabilities: {} });
 if (['thread/start', 'thread/resume', 'thread/read'].includes(method)) return result(id, threadResponse());
 if (method === 'model/list') return result(id, { data: [{ id: 'qa-model', displayName: 'QA model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] });
 if (method === 'skills/list') return result(id, { data: [] });
 if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
 if (method === 'account/rateLimits/read') return result(id, {});
 if (method === 'thread/settings/update') { collaboration = params.collaborationMode?.mode ?? collaboration; return result(id, threadResponse()); }
 if (method === 'turn/start') {
  const nativeTurn = `qa-plan-turn-${++turn}`;
  event('turn/started', { threadId: nativeId, turn: { id: nativeTurn } }); result(id, { turn: { id: nativeTurn } });
  if (collaboration === 'plan') {
   const text = params.input?.some(item => item.text === 'empty plan') ? '' : '# Proposed plan\n\n1. Inspect the current implementation.\n2. Make the focused change.\n3. Run the relevant checks.';
   event('item/completed', { threadId: nativeId, turnId: nativeTurn, item: { id: `qa-plan-${turn}`, type: 'plan', text } });
  } else event('item/completed', { threadId: nativeId, turnId: nativeTurn, item: { id: `qa-answer-${turn}`, type: 'agentMessage', text: 'Implementation started.' } });
  event('turn/completed', { threadId: nativeId, turn: { id: nativeTurn, status: 'completed' } }); return;
 }
 if (method === 'turn/interrupt') { event('turn/completed', { threadId: nativeId, turn: { id: params.turnId, status: 'interrupted' } }); return result(id, {}); }
 result(id, {});
});
