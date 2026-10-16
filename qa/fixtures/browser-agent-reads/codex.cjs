const { createInterface } = require('node:readline');
const { client, control, run, log } = require('./mcp.cjs');
const args = process.argv.slice(2), send = value => process.stdout.write(JSON.stringify(value) + '\n');
if (args.includes('--version')) { console.log('codex-browser-agent-reads-qa 1.0.0'); process.exit(0); }
if (args.includes('login')) { console.log('authenticated fixture'); process.exit(0); }
const setting = key => args.find((value, index) => args[index - 1] === '-c' && value.startsWith(key))?.slice(key.length);
const unquote = value => value?.replace(/^['"]|['"]$/g, '');
const parseList = value => { try { return JSON.parse((value || '[]').replace(/'/g, '"')); } catch { return []; } };
const env = {}; for (const match of String(setting('mcp_servers.threadterm.env=') || '').matchAll(/([A-Z0-9_]+)=('(?:[^']*)'|"(?:[^"]*)")/g)) env[match[1]] = unquote(match[2]);
const entry = { command: unquote(setting('mcp_servers.threadterm.command=')), args: parseList(setting('mcp_servers.threadterm.args=')), env };
let host, turns = 0, nativeId = `browser-agent-reads-${process.pid}`, cwd = process.env.THREADTERM_QA_BROWSER_CWD, active;
const notice = (method, params) => send({ method, params });
const thread = (id = nativeId) => ({ id, cwd, source: 'user', ephemeral: false, turns: [], status: { type: 'idle' } });
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let request; try { request = JSON.parse(line); } catch { return; } if (request.id === undefined) return;
  const { id, method, params = {} } = request, result = value => send({ id, result: value });
  if (method === 'initialize') return result({ capabilities: {} });
  if (method === 'account/read') return result({ account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result({});
  if (method === 'model/list') return result({ data: [{ id: 'browser-reads-qa', displayName: 'Browser Reads QA', supportedReasoningEfforts: [] }] });
  if (method === 'skills/list') return result({ data: [] });
  if (method === 'thread/read') return result({ thread: thread(params.threadId || nativeId), threadSettings: { model: 'browser-reads-qa' } });
  if (method === 'thread/start' || method === 'thread/resume') { cwd = params.cwd || cwd; nativeId = params.threadId || nativeId; return result({ thread: thread(), threadSettings: { model: 'browser-reads-qa' } }); }
  if (method === 'turn/interrupt') { if (active && (!params.turnId || params.turnId === active.turn) && (!params.threadId || params.threadId === nativeId)) { active.cancelled = true; host?.cancel(); notice('turn/completed', { threadId: nativeId, turn: { id: active.turn, status: 'cancelled' } }); log('turn.cancel', { turn: active.turn, notifiedMcp: false }); } else log('turn.ignoredInterrupt', { requestedTurn: params.turnId, activeTurn: active?.turn }); return result({}); }
  if (method !== 'turn/start') return result({});
  const turn = `browser-reads-turn-${++turns}`, input = params.input?.map(item => item.text || '').join(' ') || '', operation = { turn, cancelled: false }; active = operation;
  notice('turn/started', { threadId: nativeId, turn: { id: turn } }); result({ turn: { id: turn } });
  try {
    host ||= client(entry); const plan = control(input); let number = 0, tool;
    const results = await run(plan, host, (name, args) => { tool = { id: `${turn}-tool-${++number}`, type: 'mcpToolCall', server: 'threadterm', tool: name, arguments: args }; if (!operation.cancelled) notice('item/started', { threadId: nativeId, turnId: turn, item: tool }); }, (_name, _args, response) => { if (!operation.cancelled) notice('item/completed', { threadId: nativeId, turnId: turn, item: { ...tool, result: response } }); });
    if (!operation.cancelled) notice('item/completed', { threadId: nativeId, turnId: turn, item: { id: `${turn}-answer`, type: 'agentMessage', text: `BROWSER_QA_RESULT ${JSON.stringify({ id: plan.id, results })}` } });
  } catch (error) { if (!operation.cancelled) notice('item/completed', { threadId: nativeId, turnId: turn, item: { id: `${turn}-failure`, type: 'agentMessage', text: `BROWSER_QA_ERROR ${String(error.message).slice(0, 300)}` } }); }
  if (!operation.cancelled) notice('turn/completed', { threadId: nativeId, turn: { id: turn, status: 'completed' } });
  if (active === operation) active = undefined;
});
