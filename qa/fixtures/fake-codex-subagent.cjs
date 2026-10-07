// QA-only app-server: deterministic parent/child replay, no model or account.
const { appendFileSync, readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const log = process.env.THREADTERM_QA_CODEX_SUBAGENT_LOG;
const cwd = process.env.THREADTERM_QA_CODEX_SUBAGENT_CWD;
if (!log || !cwd) process.exit(2);
let parent = 'qa-subagent-parent';
const child = 'qa-subagent-child';
let sequence = 0;
let active;
let approval;
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (id, value) => send({ id, result: value });
const event = (method, params) => { record(`event.${method}`, params); send({ method, params }); };
const thread = () => ({ id: parent, cwd, status: { type: 'idle' } });
function item(threadId, turnId, value, started = false) {
  event(started ? 'item/started' : 'item/completed', { threadId, turnId, item: value });
}
function finishChild() {
  const { parentTurn, childTurn, spawnId } = active;
  item(child, childTurn, { id: `${childTurn}-command`, type: 'commandExecution', status: 'completed', command: 'echo CHILD-COMMAND', aggregatedOutput: 'CHILD-OUTPUT', exitCode: 0 });
  item(child, childTurn, { id: `${childTurn}-answer`, type: 'agentMessage', text: 'CHILD-ANSWER: three files' });
  event('turn/completed', { threadId: child, turn: { id: childTurn, status: 'completed' } });
  item(parent, parentTurn, { id: spawnId, type: 'subAgentActivity', kind: 'completed', agentThreadId: child, agentPath: '/root/count_files' });
  // Deliberate observable gap: a child completion must not make the parent idle.
  const completeParent = () => {
    if (active?.parentTurn !== parentTurn) return;
    item(parent, parentTurn, { id: `${parentTurn}-final`, type: 'agentMessage', text: 'PARENT-FINAL: verified file count' });
    event('turn/completed', { threadId: parent, turn: { id: parentTurn, status: 'completed' } });
    active = undefined;
  };
  const release = process.env.THREADTERM_QA_CODEX_SUBAGENT_RELEASE;
  if (release) {
    const timer = setInterval(() => {
      if (active?.parentTurn !== parentTurn) { clearInterval(timer); return; }
      if (readFileSync(release, 'utf8').trim() !== parentTurn) return;
      clearInterval(timer);
      completeParent();
    }, 50);
  } else setTimeout(completeParent, 4000);
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (!request.method && request.id === approval && active) {
    record('approval.response', request.result);
    if (request.result?.decision !== 'accept') throw Error('Expected accept decision');
    event('serverRequest/resolved', { threadId: child, turnId: active.childTurn, requestId: approval });
    approval = undefined;
    finishChild();
    return;
  }
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  record(method, params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'thread/start' || method === 'thread/resume') {
    const scenario = /scenario-(normal|slow|approval)$/.exec(params.cwd ?? '');
    if (scenario) parent = `qa-subagent-parent-${scenario[1]}`;
    return result(id, { thread: thread(), threadSettings: { model: 'qa-subagent-model', approvalPolicy: 'on-request' } });
  }
  if (method === 'thread/read') return result(id, { thread: thread() });
  if (method === 'model/list') return result(id, { data: [{ id: 'qa-subagent-model', displayName: 'QA subagent model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] });
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'turn/start') {
    const number = ++sequence;
    const mode = params.input?.map(value => value.text ?? '').join(' ') ?? '';
    active = { parentTurn: `qa-parent-turn-${number}`, childTurn: `qa-child-turn-${number}`, spawnId: `qa-spawn-${number}` };
    const { parentTurn, childTurn, spawnId } = active;
    event('turn/started', { threadId: parent, turn: { id: parentTurn } });
    result(id, { turn: { id: parentTurn } });
    item(parent, parentTurn, { id: `${parentTurn}-initial`, type: 'agentMessage', text: 'PARENT-INITIAL: delegating count' });
    item(parent, parentTurn, { id: spawnId, type: 'subAgentActivity', kind: 'started', agentThreadId: child, agentPath: '/root/count_files' });
    event('thread/started', { thread: { id: child, parentThreadId: parent, agentNickname: 'Kant', agentRole: 'standard_worker', source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/count_files', agent_nickname: 'Kant', agent_role: 'standard_worker' } } } } });
    event('turn/started', { threadId: child, turn: { id: childTurn } });
    item(child, childTurn, { id: `${childTurn}-command`, type: 'commandExecution', status: 'inProgress', command: 'echo CHILD-COMMAND' }, true);
    if (mode.includes('slow')) return;
    if (mode.includes('approval')) {
      approval = `qa-child-approval-${number}`;
      send({ id: approval, method: 'item/commandExecution/requestApproval', params: { threadId: child, turnId: childTurn, itemId: `${childTurn}-command`, command: 'echo CHILD-COMMAND', reason: 'Child command approval' } });
      return;
    }
    setTimeout(finishChild, 400);
    return;
  }
  if (method === 'turn/interrupt') {
    if (!active) throw Error('No active parent');
    record('interrupt.recorded', params);
    const { parentTurn, childTurn } = active;
    event('turn/completed', { threadId: child, turn: { id: childTurn, status: 'interrupted' } });
    event('turn/completed', { threadId: parent, turn: { id: parentTurn, status: 'interrupted' } });
    active = undefined;
    return result(id, {});
  }
  send({ id, error: { code: -32000, message: `Unexpected QA request: ${method}` } });
});
