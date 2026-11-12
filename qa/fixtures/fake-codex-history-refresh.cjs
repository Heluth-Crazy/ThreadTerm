// A warm worker snapshots history when it opens the thread. A separate
// thread/read sees the on-disk history without updating the warm worker.
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const { TT_QA_HISTORY_FILE: historyFile, TT_QA_HISTORY_CWD: cwd, TT_QA_HISTORY_LOG: log } = process.env;
const threadId = 'qa-history-refresh-thread';
const model = 'qa-history-refresh-model';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.166.0');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('Usage: codex app-server --no-alt-screen');
  process.exit(0);
}
if (args.includes('login') && args.includes('status')) {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (!args.includes('app-server') || !historyFile || !cwd || !log) process.exit(2);

const readHistory = () => JSON.parse(readFileSync(historyFile, 'utf8'));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => send({ method, params });
const record = value => appendFileSync(log, JSON.stringify({ pid: process.pid, ...value }) + '\n');
let loaded;

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  const ok = result => send({ id, result });
  const fail = message => send({ id, error: { code: -32000, message } });
  const thread = { id: threadId, cwd, status: { type: 'idle' }, turns: [] };
  if (method === 'initialize') return ok({ capabilities: {}, userAgent: 'codex_cli_rs/0.166.0' });
  if (method === 'thread/resume' || method === 'thread/start') {
    if (method === 'thread/resume' && params.threadId !== threadId) return fail('Wrong native thread');
    if (existsSync(historyFile + '.fail-resume')) return fail('QA native reopen unavailable');
    loaded = readHistory();
    record({ method, threadId });
    return ok({ thread, threadSettings: { model, approvalPolicy: 'on-request' } });
  }
  if (method === 'thread/read') {
    if (params.threadId !== threadId) return fail('Wrong native thread');
    if (params.includeTurns) {
      if (existsSync(historyFile + '.fail-read')) return fail('QA history read unavailable');
      thread.turns = readHistory();
      record({ method, threadId, turnIds: thread.turns.map(turn => turn.id) });
    }
    return ok({ thread });
  }
  if (method === 'account/read') return ok({ account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'model/list') return ok({ data: [{ id: model, displayName: 'History refresh QA' }] });
  if (method === 'skills/list' || method === 'thread/backgroundTerminals/list') return ok({ data: [] });
  if (method === 'turn/start') {
    if (params.threadId !== threadId || !loaded) return fail('No loaded native thread');
    const text = params.input?.find(part => part.type === 'text')?.text;
    const seesExternal = loaded.some(turn => turn.id === 'external-latest' && turn.status === 'completed');
    const reply = text === 'use external context'
      ? (seesExternal ? 'saw latest external turn' : 'stale native context')
      : 'local answer for ' + text;
    const history = readHistory();
    const turnId = 'local-' + (history.filter(turn => turn.id.startsWith('local-')).length + 1);
    const user = { id: turnId + '-rebuilt-user', type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] };
    // A reopened app-server can reconstruct different item IDs for the same
    // explicit native turn. Only the live projected reply has the live ID.
    const assistant = { id: turnId + '-rebuilt-answer', type: 'agentMessage', phase: 'final_answer', text: reply };
    record({ method, threadId, turnId, text, seesExternal });
    event('turn/started', { threadId, turn: { id: turnId } });
    ok({ turn: { id: turnId } });
    const complete = () => {
      const completed = { id: turnId, status: 'completed', items: [user, assistant] };
      writeFileSync(historyFile, JSON.stringify([...readHistory(), completed]));
      loaded.push(completed);
      event('item/completed', { threadId, turnId, item: { ...assistant, id: turnId + '-live-answer' } });
      event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    };
    if (text === 'slow local prompt') {
      const timer = setInterval(() => {
        if (!existsSync(historyFile + '.complete-slow')) return;
        clearInterval(timer);
        complete();
      }, 35);
    } else {
      setTimeout(complete, 35);
    }
    return;
  }
  ok({});
});
