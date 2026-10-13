// Synthetic app-server only: no command or model is actually executed.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
if (process.argv.includes('--version')) { console.log('codex-cli 0.161.0'); process.exit(0); }
const cwd = process.env.THREADTERM_QA_BACKGROUND_CWD, log = process.env.THREADTERM_QA_BACKGROUND_LOG;
if (!cwd || !log) process.exit(2);
const threadId = 'qa-background-thread';
const processes = new Map();
let turnCount = 0;
const result = (id, value) => process.stdout.write(`${JSON.stringify({ id, result: value })}\n`);
const emit = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
const command = (processId, status = 'inProgress') => ({
  id: `tool-${processId}`, type: 'commandExecution', processId, status,
  command: `node synthetic-${processId}.mjs`, cwd, aggregatedOutput: `Synthetic output for ${processId}\n`,
  exitCode: status === 'inProgress' ? null : 0,
});
const settings = { model: 'qa-background-model', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } };
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (['thread/start', 'thread/resume', 'thread/read'].includes(method)) return result(id, { thread: { id: threadId, cwd, ...settings }, threadSettings: settings });
  if (method === 'model/list') return result(id, { data: [{ id: settings.model, displayName: 'Background QA', supportedReasoningEfforts: [] }] });
  if (method === 'skills/list' || method === 'account/rateLimits/read') return result(id, { data: [] });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'thread/backgroundTerminals/list') {
    const rows = [...processes.values()].map(processId => ({ command: command(processId).command, cwd, itemId: `tool-${processId}`, processId }));
    // One row per page verifies all-cursor aggregation.
    const index = params.cursor ? Number(params.cursor) : 0;
    return result(id, { data: rows.slice(index, index + 1), nextCursor: index + 1 < rows.length ? String(index + 1) : null });
  }
  if (method === 'thread/backgroundTerminals/terminate') {
    if (params.threadId !== threadId) return result(id, { terminated: false });
    const removed = processes.delete(params.processId);
    return result(id, { terminated: removed });
  }
  if (method === 'turn/start') {
    const turnId = `background-turn-${++turnCount}`;
    result(id, { turn: { id: turnId } });
    emit('turn/started', { threadId, turn: { id: turnId } });
    if (turnCount === 1) {
      for (const processId of ['first', 'second']) {
        processes.set(processId, processId);
        emit('item/started', { threadId, turnId, item: command(processId) });
      }
      // A normal foreground call must never appear in the strip.
      emit('item/started', { threadId, turnId, item: command('foreground') });
      emit('item/completed', { threadId, turnId, item: command('foreground', 'completed') });
    }
    emit('item/completed', { threadId, turnId, item: { id: `answer-${turnId}`, type: 'agentMessage', phase: 'final_answer', text: 'Synthetic background work continues after this reply.' } });
    setTimeout(() => emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }), 300);
    return;
  }
  if (method === 'turn/interrupt') return result(id, {});
  process.stdout.write(`${JSON.stringify({ id, error: { code: -32601, message: `Unexpected QA method: ${method}` } })}\n`);
});
