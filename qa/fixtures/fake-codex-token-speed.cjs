// Deterministic, offline Codex app-server fixture for token-speed Desktop QA.
const TOKEN_SPEED_CODEX_SCENARIO = Object.freeze({
  threadId: 'qa-token-speed-thread',
  modelId: 'qa-token-speed',
  firstOutputTokens: 320,
  secondOutputTokens: 480,
  firstTokenMs: 400,
  firstStreamMs: 1000,
  toolMs: 1000,
  secondStreamMs: 1800,
  firstChunks: ['First model call starts streaming. ', 'Its exact usage will replace this estimate. '],
  secondChunks: ['Second model call resumes after the command. ', 'The final exact count is deterministic. '],
});
module.exports = { TOKEN_SPEED_CODEX_SCENARIO };

if (require.main === module) {
  const { appendFileSync } = require('node:fs');
  const { createInterface } = require('node:readline');
  const logPath = process.env.TT_QA_TOKEN_SPEED_CODEX_LOG;
  const cwd = process.env.TT_QA_TOKEN_SPEED_CODEX_CWD;
  const record = (direction, method, params = {}) => { if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), direction, method, params })}\n`); };
  if (process.argv.includes('--version')) { record('cli', '--version', { exitCode: 0 }); console.log('qa-token-speed-codex 1.0.0'); process.exit(0); }
  // CodexAdapter gates Chat on a successful CLI login/status probe, before it
  // opens app-server or reads account/read. This fixture never uses real auth.
  if (process.argv.slice(2).join(' ') === 'login status') { record('cli', 'login/status', { exitCode: 0 }); console.log('Logged in using the offline QA fixture'); process.exit(0); }
  if (!logPath || !cwd) { record('cli', 'configuration-missing', { exitCode: 2 }); process.exit(2); }
  if (!process.argv.includes('app-server')) { record('cli', 'unsupported', { exitCode: 64 }); process.exit(64); }
  record('cli', 'app-server');

  let turnSerial = 0;
  const send = value => { record('out', value.method ?? 'response', value.params ?? value); process.stdout.write(`${JSON.stringify(value)}\n`); };
  const result = (id, value) => send({ id, result: value });
  const event = (method, params) => send({ method, params });
  const marker = (name, turnId) => record('marker', name, { turnId });
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const thread = () => ({ id: TOKEN_SPEED_CODEX_SCENARIO.threadId, cwd, source: 'user', ephemeral: false, turns: [], status: { type: 'idle' } });
  const stream = async (turnId, chunks, durationMs, itemId) => {
    event('item/started', { threadId: TOKEN_SPEED_CODEX_SCENARIO.threadId, turnId, item: { id: itemId, type: 'agentMessage' } });
    for (const text of chunks) {
      event('item/agentMessage/delta', { threadId: TOKEN_SPEED_CODEX_SCENARIO.threadId, turnId, itemId, delta: text });
      await wait(durationMs / chunks.length);
    }
    event('item/completed', { threadId: TOKEN_SPEED_CODEX_SCENARIO.threadId, turnId, item: { id: itemId, type: 'agentMessage', text: chunks.join('') } });
  };
  const runTurn = async turnId => {
    marker('turn-start', turnId);
    await wait(TOKEN_SPEED_CODEX_SCENARIO.firstTokenMs);
    await stream(turnId, TOKEN_SPEED_CODEX_SCENARIO.firstChunks, TOKEN_SPEED_CODEX_SCENARIO.firstStreamMs, `${turnId}-first`);
    event('thread/tokenUsage/updated', { threadId: TOKEN_SPEED_CODEX_SCENARIO.threadId, turnId, tokenUsage: { last: { inputTokens: 100, outputTokens: TOKEN_SPEED_CODEX_SCENARIO.firstOutputTokens, totalTokens: 420 } } });
    marker('usage-first', turnId);
    const toolId = `${turnId}-tool`;
    marker('tool-start', turnId);
    event('item/started', { threadId: TOKEN_SPEED_CODEX_SCENARIO.threadId, turnId, item: { id: toolId, type: 'commandExecution', command: 'token-speed-fixture wait', status: 'inProgress' } });
    await wait(TOKEN_SPEED_CODEX_SCENARIO.toolMs);
    event('item/completed', { threadId: TOKEN_SPEED_CODEX_SCENARIO.threadId, turnId, item: { id: toolId, type: 'commandExecution', command: 'token-speed-fixture wait', status: 'completed', exitCode: 0 } });
    marker('tool-end', turnId);
    marker('second-call-start', turnId);
    await stream(turnId, TOKEN_SPEED_CODEX_SCENARIO.secondChunks, TOKEN_SPEED_CODEX_SCENARIO.secondStreamMs, `${turnId}-second`);
    event('thread/tokenUsage/updated', { threadId: TOKEN_SPEED_CODEX_SCENARIO.threadId, turnId, tokenUsage: { last: { inputTokens: 120, outputTokens: TOKEN_SPEED_CODEX_SCENARIO.secondOutputTokens, totalTokens: 600 } } });
    marker('usage-second', turnId);
    event('turn/completed', { threadId: TOKEN_SPEED_CODEX_SCENARIO.threadId, turn: { id: turnId, status: 'completed' } });
    marker('turn-completed', turnId);
  };

  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    if (!line.trim()) return;
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const { id, method, params = {} } = request;
    record('in', method, params);
    if (method === 'initialize') return result(id, { capabilities: {} });
    if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
    if (method === 'account/rateLimits/read') return result(id, {});
    if (method === 'model/list') return result(id, { data: [{ id: TOKEN_SPEED_CODEX_SCENARIO.modelId, displayName: 'QA token speed', supportedReasoningEfforts: [] }] });
    if (method === 'skills/list') return result(id, { data: [] });
    if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/read') return result(id, { thread: thread(), threadSettings: { model: TOKEN_SPEED_CODEX_SCENARIO.modelId, approvalPolicy: 'on-request' } });
    // New Chat creation injects an empty developer item, then verifies this
    // stable fixture thread through another app-server's thread/read.
    if (method === 'thread/inject_items') return result(id, {});
    if (method === 'turn/start') {
      const turnId = `qa-token-speed-turn-${++turnSerial}`;
      event('turn/started', { threadId: TOKEN_SPEED_CODEX_SCENARIO.threadId, turn: { id: turnId } });
      result(id, { turn: { id: turnId } });
      void runTurn(turnId);
      return;
    }
    if (method === 'turn/interrupt') return result(id, {});
    send({ id, error: { code: -32000, message: `Unexpected token-speed fixture request: ${method}` } });
  });
}
