// QA-only Codex surface for session release/resume: one app-server and a terminal process.
// It never contacts Codex or a model.
const { createInterface } = require('node:readline');

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex_cli_rs/0.200.0\n');
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write('Usage: codex [OPTIONS] [PROMPT]\n  resume  Resume a saved conversation\n  --no-alt-screen\n  app-server\n');
  process.exit(0);
}

const nativeId = `qa-release-${process.pid}`;
const isAppServer = args.includes('app-server');
if (!isAppServer) {
  // The PTY terminal process: a live process with visible output.
  process.stdout.write(`QA release terminal ${nativeId}\r\n`);
  setInterval(() => {}, 1000);
  process.stdin.resume();
} else {
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const result = (id, value) => send({ id, result: value });
  const event = (method, params) => send({ method, params });
  let turn = 0;
  const thread = (id = nativeId) => ({ id, cwd: process.env.THREADTERM_QA_CODEX_COMPAT_CWD, status: { type: 'idle' }, turns: [] });
  const settings = () => ({ model: 'qa-release-model', approvalPolicy: 'on-request' });
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    if (!line.trim()) return;
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const { id, method, params = {} } = request;
    if (method === 'initialize') return result(id, { capabilities: {}, userAgent: 'codex_cli_rs/0.200.0' });
    if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
    if (method === 'account/rateLimits/read') return result(id, {});
    if (method === 'thread/start') return result(id, { thread: thread(), threadSettings: settings() });
    if (method === 'thread/resume') return result(id, { thread: thread(params.threadId ?? nativeId), threadSettings: settings() });
    if (method === 'thread/read') return result(id, { thread: thread(params.threadId ?? nativeId) });
    if (method === 'thread/inject_items') return result(id, {});
    if (method === 'thread/backgroundTerminals/list') return result(id, { data: [] });
    if (method === 'model/list') return result(id, { data: [{ id: 'qa-release-model', displayName: 'QA release model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] });
    if (method === 'skills/list') return result(id, { data: [] });
    if (method === 'thread/settings/update') { result(id, {}); event('thread/settings/updated', { threadId: nativeId, threadSettings: settings() }); return; }
    if (method === 'turn/start') {
      const nativeTurn = `qa-release-turn-${++turn}`;
      event('turn/started', { threadId: nativeId, turn: { id: nativeTurn } });
      result(id, { turn: { id: nativeTurn } });
      return;
    }
    if (method === 'turn/interrupt') {
      event('turn/completed', { threadId: nativeId, turn: { id: params.turnId, status: 'interrupted' } });
      return result(id, {});
    }
    result(id, {});
  });
}
