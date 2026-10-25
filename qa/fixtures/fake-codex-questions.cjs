// Deterministic app-server fixture for question-card native-pipe QA. It never
// invokes Codex, a model, or any provider executable.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const log = process.env.THREADTERM_QA_CODEX_QUESTIONS_LOG;
const cwd = process.env.THREADTERM_QA_CODEX_QUESTIONS_CWD;
if (!log || !cwd) process.exit(2);
// 42403c6 verifies durability through a second app-server process, so this
// native id represents storage shared by both fixture processes.
const nativeId = 'qa-codex-questions-thread';
let turn = 0;
const record = (direction, method, params) => appendFileSync(log, `${JSON.stringify({ direction, method, params })}\n`);
const send = value => { record('out', value.method ?? 'response', value.params ?? value); process.stdout.write(`${JSON.stringify(value)}\n`); };
const result = (id, value) => send({ id, result: value });
const event = (method, params) => send({ method, params });
const thread = () => ({ id: nativeId, cwd, model: 'qa-question-model', status: { type: 'idle' }, turns: [] });
const persistedThread = params => params?.threadId === nativeId
  && Array.isArray(params.items)
  && params.items.length === 1
  && params.items[0]?.type === 'message'
  && params.items[0]?.role === 'developer'
  && Array.isArray(params.items[0]?.content)
  && params.items[0].content.length === 0;

function finish(nativeTurn) {
  event('turn/completed', { threadId: nativeId, turn: { id: nativeTurn, status: 'completed' } });
}
function question(nativeTurn, prompt) {
  const requestId = kind => `${kind}-${turn}`;
  if (prompt === 'single') return send({ id: requestId('qa-single'), method: 'item/tool/requestUserInput', params: {
    threadId: nativeId, turnId: nativeTurn, itemId: 'single-question-item',
    questions: [{ id: 'priority', header: 'Priority', question: 'Choose the priority', options: [{ label: 'Blue', description: 'The default priority' }, { label: 'Red', description: 'The urgent priority' }] }],
  }});
  if (prompt === 'form') {
    return send({ id: requestId('qa-form'), method: 'mcpServer/elicitation/request', params: {
      threadId: nativeId, turnId: nativeTurn, serverName: 'qa', mode: 'form', message: 'Configure QA',
      requestedSchema: { type: 'object', required: ['count', 'colour'], properties: {
        name: { type: 'string', title: 'Name', minLength: 2, maxLength: 20, format: 'email' },
        count: { type: 'integer', minimum: 1, maximum: 5 }, enabled: { type: 'boolean', default: true },
        colour: { type: 'string', oneOf: [{ const: 'blue', title: 'Blue' }, { const: 'red', title: 'Red' }] },
        tags: { type: 'array', items: { anyOf: [{ const: 'one', title: 'One' }, { const: 'two', title: 'Two' }] }, minItems: 1, maxItems: 2 },
      } },
    }});
  }
  if (prompt === 'unsupported') return send({ id: requestId('qa-unsupported'), method: 'mcpServer/elicitation/request', params: {
    threadId: nativeId, turnId: nativeTurn, serverName: 'qa', mode: 'form', message: 'Unsupported',
    requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } },
  }});
  if (prompt === 'url') return send({ id: requestId('qa-url'), method: 'mcpServer/elicitation/request', params: {
    threadId: nativeId, turnId: nativeTurn, serverName: 'qa', mode: 'url', message: 'Complete in browser', elicitationId: 'url-1', url: 'https://example.test/form',
  }});
  return send({ id: requestId('qa-input'), method: 'item/tool/requestUserInput', params: {
    threadId: nativeId, turnId: nativeTurn, itemId: 'question-item', isBlocking: false, autoResolutionMs: 15000,
    questions: [
      { id: 'colour', header: 'Colour', question: 'Choose a colour', options: [{ label: 'Blue', description: 'The blue choice' }], isOther: true },
      { id: 'token', header: 'Token', question: 'Enter token', options: null, isSecret: true },
    ],
  }});
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line); if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  const reverseResponse = String(id).startsWith('qa-') && method === undefined;
  record('in', reverseResponse ? String(id) : method, reverseResponse ? request.result : params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/start' || method === 'thread/resume') return result(id, { thread: thread(), threadSettings: { model: 'qa-question-model', approvalPolicy: 'on-request' } });
  // 42403c6: a fresh Codex Chat persists its empty native thread with this
  // exact developer item before the first user turn.
  if (method === 'thread/inject_items') {
    if (!persistedThread(params)) return send({ id, error: { code: -32602, message: 'invalid QA thread persistence item' } });
    return result(id, {});
  }
  if (method === 'thread/read') return result(id, { thread: thread() });
  if (method === 'model/list') return result(id, { data: [{ id: 'qa-question-model', displayName: 'QA question', supportedReasoningEfforts: [] }] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'turn/start') { const nativeTurn = `qa-question-turn-${++turn}`; event('turn/started', { threadId: nativeId, turn: { id: nativeTurn } }); result(id, { turn: { id: nativeTurn } }); return question(nativeTurn, params.input?.[0]?.text ?? 'input'); }
  if (reverseResponse) {
    event('serverRequest/resolved', { threadId: nativeId, turnId: `qa-question-turn-${turn}`, requestId: id });
    return finish(`qa-question-turn-${turn}`);
  }
  if (method === 'turn/interrupt') { finish(params.turnId); return result(id, {}); }
  send({ id, error: { code: -32000, message: `Unexpected QA request: ${method}` } });
});
