// Isolated Codex app-server fixture. It has no network/provider path.
const { appendFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
if (process.argv.includes('--version')) {
    console.log('qa-latency-codex 1');
    process.exit(0);
}
if (process.argv.includes('--protocol-selftest'))
    process.exit(process.argv.includes('app-server') ? 0 : 64);
if (!process.argv.includes('app-server'))
    process.exit(64);
const { TT_QA_FAKE_CODEX_LOG: log, TT_QA_FAKE_CODEX_CWD: cwd, TT_QA_FAKE_RELEASE_FILE: release } = process.env;
if (!log || !cwd || !release)
    process.exit(2);
let turn = 0;
const threadId = 'qa-latency-thread';
const durableUser = () => {
    const { TT_QA_PYTHON: python, TT_QA_RUNTIME_DB: db, TT_QA_PROMPT: prompt } = process.env;
    if (!python || !db || !prompt)
        return false;
    const code = "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(int(bool(c.execute(\"select 1 from chat_items where json_extract(data,'$.role')='user' and data like ? limit 1\",('%'+sys.argv[2]+'%',)).fetchone())))";
    const child = spawnSync(python, ['-c', code, db, prompt], { encoding: 'utf8', windowsHide: true });
    return child.status === 0 && child.stdout.trim() === '1';
};
const note = (direction, method, extra = {}) => appendFileSync(log, `${JSON.stringify({ at: Date.now(), direction, method, ...extra })}\n`);
const send = row => { note('out', row.method ?? 'response'); process.stdout.write(`${JSON.stringify(row)}\n`); };
const reply = (id, result) => send({ id, result });
const event = (method, params) => send({ method, params });
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    if (!line.trim())
        return;
    const request = JSON.parse(line);
    if (request.id === undefined)
        return;
    const { id, method } = request;
    note('in', method, method === 'turn/start' ? { durableUser: durableUser() } : {});
    if (method === 'initialize')
        return reply(id, { capabilities: {} });
    if (method === 'account/read')
        return reply(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
    if (method === 'account/rateLimits/read')
        return reply(id, {});
    if (method === 'model/list')
        return reply(id, { data: [{ id: 'qa-latency', displayName: 'QA latency', supportedReasoningEfforts: [] }] });
    if (method === 'skills/list')
        return reply(id, { data: [] });
    if (method === 'thread/start' || method === 'thread/resume')
        return reply(id, { thread: { id: threadId, cwd, status: { type: 'idle' } }, threadSettings: { model: 'qa-latency', approvalPolicy: 'on-request' } });
    if (method === 'turn/start') {
        const idTurn = `qa-latency-turn-${++turn}`;
        event('turn/started', { threadId, turn: { id: idTurn } });
        reply(id, { turn: { id: idTurn } });
        const timer = setInterval(() => { if (!existsSync(release))
            return; clearInterval(timer); event('item/completed', { threadId, turnId: idTurn, item: { id: `${idTurn}-answer`, type: 'agentMessage', text: 'fake latency answer' } }); event('turn/completed', { threadId, turn: { id: idTurn, status: 'completed' } }); }, 40);
        return;
    }
    if (method === 'turn/interrupt')
        return reply(id, {});
    reply(id, {});
});
