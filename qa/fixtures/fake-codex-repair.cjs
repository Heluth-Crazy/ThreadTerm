// Deterministic history-repair fixture. It only implements the fake Codex
// app-server protocol and never invokes a real provider.
const { appendFileSync, readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const log = process.env.THREADTERM_QA_CODEX_REPAIR_LOG;
const cwd = process.env.THREADTERM_QA_CODEX_REPAIR_CWD;
if (!log || !cwd) process.exit(2);
const argv = process.argv.slice(2);
const nativeId = 'qa-codex-repair-thread';
let turn = 0;
const record = (direction, method, params) => appendFileSync(log, `${JSON.stringify({ direction, method, params })}\n`);
const send = value => { record('out', value.method ?? 'response', value.params ?? value); process.stdout.write(`${JSON.stringify(value)}\n`); };
const result = (id, value) => send({ id, result: value });
const event = (method, params) => send({ method, params });
const thread = (id = nativeId) => ({ id, cwd, model: 'qa-repair-model', status: { type: 'idle' }, turns: [] });
// The read-only repair helper is a separate process. Only expose repair history
// after a real fake turn was requested, never during empty new-chat verification.
const hasHistory = () => readFileSync(log, 'utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse).some(row => row.direction === 'in' && row.method === 'turn/start');
const history = (id) => ({ thread: thread(id), turns: id === nativeId && hasHistory() ? [{ id: 'qa-repair-native-turn', items: [
  { id: 'qa-repair-native-user', type: 'userMessage', text: 'native user' },
  { id: 'qa-repair-native-tool', type: 'commandExecution', status: 'completed', command: 'echo native tool', aggregatedOutput: 'native tool output' },
  { id: 'qa-repair-native-assistant', type: 'agentMessage', text: 'native final answer' },
] }] : [] });

if (argv.includes('--version')) { process.stdout.write('codex-qa-repair-fixture 1.0.0\n'); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') { process.stdout.write('authenticated QA fixture\n'); process.exit(0); }
// The runtime prefixes `-c key=value` overrides (delegation MCP server) before the subcommand.
const subcommand = argv.filter((arg, index) => arg !== '-c' && argv[index - 1] !== '-c');
if (subcommand[0] !== 'app-server' || subcommand.slice(1).some(arg => arg !== '--stdio')) { record('unexpectedInvocation', argv); process.stderr.write('fake Codex only supports app-server\n'); process.exit(3); }

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line); if (request.id === undefined) return;
  const { id, method, params = {} } = request; record('in', method, params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/inject_items') return result(id, {});
  if (method === 'thread/start' || method === 'thread/resume') return result(id, { thread: thread(method === 'thread/resume' ? params.threadId : nativeId), threadSettings: { model: 'qa-repair-model', approvalPolicy: 'on-request' } });
  if (method === 'thread/read') { const native = history(params.threadId); return result(id, { thread: { ...native.thread, turns: native.turns } }); } // real thread/read nests turns in thread (codex.rs history_read)
  if (method === 'model/list') return result(id, { data: [{ id: 'qa-repair-model', displayName: 'QA repair', supportedReasoningEfforts: [] }] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'turn/start') {
    const nativeTurn = `qa-repair-live-turn-${++turn}`;
    event('turn/started', { threadId: nativeId, turn: { id: nativeTurn } }); result(id, { turn: { id: nativeTurn } });
    send({ id: 'qa-repair-pending', method: 'item/commandExecution/requestApproval', params: { threadId: nativeId, turnId: nativeTurn, command: 'echo pending request' } });
    event('item/started', { threadId: nativeId, turnId: nativeTurn, item: { id: `${nativeTurn}-lost`, type: 'agentMessage' } });
    event('item/agentMessage/delta', { threadId: nativeId, turnId: nativeTurn, itemId: `${nativeTurn}-lost`, delta: 'projection must fail here' });
    return;
  }
  if (method === 'turn/interrupt') { event('turn/completed', { threadId: nativeId, turn: { id: params.turnId, status: 'interrupted' } }); return result(id, {}); }
  send({ id, error: { code: -32000, message: `Unexpected QA request: ${method}` } });
});
