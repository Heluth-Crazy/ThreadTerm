// Isolated native-provider fixture for qa/send-latency-breakdown.mjs. It never
// invokes a provider CLI or network service. Select a protocol with
// TT_QA_LATENCY_MODE=codex|acp|claude (or --mode=<name>).
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const flag = process.argv.find(value => value.startsWith('--mode='));
const mode = (flag ? flag.slice('--mode='.length) : process.env.TT_QA_LATENCY_MODE || 'codex').toLowerCase();
if (!['codex', 'acp', 'claude'].includes(mode)) {
  process.stderr.write('TT_QA_LATENCY_MODE must be codex, acp, or claude\n');
  process.exit(64);
}
if (mode === 'claude' && process.argv.includes('auth') && process.argv.includes('status')) {
  process.stdout.write('{"loggedIn":true,"authMethod":"qa-fixture"}\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write(`qa-send-latency-${mode} 1.0.0\n`);
  process.exit(0);
}

const delayMs = Math.max(0, Number.parseInt(process.env.TT_QA_PROVIDER_DELAY_MS || '0', 10) || 0);
const resultDelayMs = Math.max(0, Number.parseInt(process.env.TT_QA_PROVIDER_RESULT_DELAY_MS || '50', 10) || 0);
const logPath = process.env.TT_QA_LATENCY_LOG;
const log = (kind, detail = {}) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), monotonicUs: Number(process.hrtime.bigint() / 1000n), pid: process.pid, mode, kind, ...detail })}\n`);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const rpc = (id, result) => write({ jsonrpc: '2.0', id, result });
const codexReply = (id, result) => write({ id, result });
const notification = (method, params) => write({ jsonrpc: '2.0', method, params });
const codexNotification = (method, params) => write({ method, params });
let turn = 0;
const sessionId = 'qa-send-latency-session';
const threadId = 'qa-send-latency-thread';

async function accept(request) {
  log('native-incoming', { method: request.method ?? request.op, id: request.id });
  if (request.id === undefined) return;
  const prompt = mode === 'codex' ? request.method === 'turn/start'
    : mode === 'acp' ? request.method === 'session/prompt'
      : request.op === 'session.send';
  if (prompt && mode !== 'acp') await wait(delayMs);

  if (mode === 'codex') {
    const { id, method } = request;
    if (method === 'initialize') return codexReply(id, { capabilities: {} });
    if (method === 'account/read') return codexReply(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
    if (method === 'account/rateLimits/read') return codexReply(id, {});
    if (method === 'model/list') return codexReply(id, { data: [{ id: 'qa-send-latency', displayName: 'QA send latency', supportedReasoningEfforts: [] }] });
    if (method === 'skills/list') return codexReply(id, { data: [] });
    if (method === 'thread/start' || method === 'thread/resume') return codexReply(id, { thread: { id: threadId, status: { type: 'idle' } }, threadSettings: { model: 'qa-send-latency' } });
    // New-chat verification reads the thread back through a second app-server process.
    if (method === 'thread/read') return codexReply(id, { thread: { id: threadId, turns: [], status: { type: 'idle' } } });
    if (method === 'turn/interrupt') return codexReply(id, {});
    if (method === 'turn/start') {
      const turnId = `qa-send-latency-turn-${++turn}`;
      log('acceptance-reply', { method, id, turnId });
      codexReply(id, { turn: { id: turnId } });
      setTimeout(() => {
        log('model-result', { turnId });
        codexNotification('turn/started', { threadId, turn: { id: turnId } });
        codexNotification('item/completed', { threadId, turnId, item: { id: `${turnId}-answer`, type: 'agentMessage', text: 'QA latency result' } });
        codexNotification('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
      }, resultDelayMs);
      return;
    }
    return codexReply(id, {});
  }

  if (mode === 'acp') {
    const { id, method, params = {} } = request;
    if (method === 'initialize') return rpc(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { load: {}, resume: {}, list: {} } } });
    if (method === 'initialized') return;
    if (method === 'session/new' || method === 'session/load' || method === 'session/resume') return rpc(id, { sessionId: params.sessionId || sessionId });
    if (method === 'session/cancel') return rpc(id, {});
    if (method === 'session/prompt') {
      const bound = params.sessionId || sessionId;
      setTimeout(() => {
        log('model-result', { sessionId: bound });
        notification('session/update', { sessionId: bound, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'QA latency result' } } });
        // ACP's prompt response is turn completion, not acceptance. The async
        // adapter has already returned after writing the request to stdin.
        log('acceptance-reply', { method, id, sessionId: bound, semantic: 'completion' });
        rpc(id, { stopReason: 'end_turn' });
      }, delayMs);
      return;
    }
    return rpc(id, {});
  }

  const { id, op } = request;
  if (op === 'host.ping') return write({ id, ok: { pid: process.pid } });
  if (op === 'history.read') return write({ id, ok: { messages: [] } });
  if (op === 'session.start') return write({ id, ok: { sessionId: request.sessionId || sessionId, ui: { options: [], commands: [] } } });
  if (op === 'session.stop' || op === 'session.interrupt') return write({ id, ok: {} });
  if (op === 'session.send') {
    const operationId = request.operationId || `qa-send-latency-turn-${++turn}`;
    // The real sidecar marks the turn running before its synchronous reply.
    write({ ev: 'session.status', cardId: request.cardId, operationId, phase: 'running', sessionId });
    log('acceptance-reply', { op, id, operationId });
    write({ id, ok: {} });
    setTimeout(() => {
      log('model-result', { operationId });
      // Match ClaudeSession.run(): a streamed text delta creates the visible
      // response, then its final assistant snapshot is explicitly streamed.
      // An unmarked snapshot is intentionally de-duplicated by the runtime.
      write({ ev: 'session.event', cardId: request.cardId, operationId, message: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'QA latency result' } } } });
      write({ ev: 'session.event', cardId: request.cardId, operationId, streamed: true,
        message: { type: 'assistant', message: { id: `${operationId}-answer`, content: [{ type: 'text', text: 'QA latency result' }] } } });
      write({ ev: 'session.status', cardId: request.cardId, operationId, phase: 'idle', status: 'completed' });
    }, resultDelayMs);
    return;
  }
  write({ id, error: { message: `unsupported QA latency sidecar operation: ${op}` } });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  accept(request).catch(error => {
    log('fixture-error', { message: String(error) });
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
});
