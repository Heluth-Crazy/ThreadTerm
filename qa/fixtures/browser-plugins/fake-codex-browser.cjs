// Isolated Codex app-server fixture. It accepts the real per-open `-c
// mcp_servers.threadterm.*` overrides and proves they yield an executable MCP
// server rather than merely renderer state.
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const args = process.argv.slice(2);
// Do not record command arguments: they can contain session grants in MCP env.
const event = (name, detail = {}) => process.env.THREADTERM_QA_BROWSER_EVENTS && appendFileSync(process.env.THREADTERM_QA_BROWSER_EVENTS, JSON.stringify({ name, detail }) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, value) => send({ id, result: value });
const notice = (method, params) => send({ method, params });
if (args.includes('--version')) { console.log('codex-browser-qa 1.0.0'); process.exit(0); }
if (args.includes('login')) { console.log('authenticated fixture'); process.exit(0); }
const subcommand = args.filter((value, index) => value !== '-c' && args[index - 1] !== '-c');
if (subcommand[0] !== 'app-server') throw Error(`unexpected invocation ${args.join(' ')}`);
const setting = key => args.find((value, index) => args[index - 1] === '-c' && value.startsWith(key))?.slice(key.length);
const unquote = value => value?.replace(/^['"]|['"]$/g, '');
const command = unquote(setting('mcp_servers.threadterm.command='));
const rawArgs = setting('mcp_servers.threadterm.args=') ?? '[]';
const rawEnv = setting('mcp_servers.threadterm.env=') ?? '{}';
function parseTomlList(value) { try { return JSON.parse(value.replace(/'/g, '"')); } catch { return []; } }
function parseEnv(value) { const output = {}; for (const match of value.matchAll(/([A-Z0-9_]+)=('(?:[^']*)'|"(?:[^"]*)")/g)) output[match[1]] = unquote(match[2]); return output; }
async function mcpCall(name, arguments_) {
  if (!command) throw Error('missing session-local ThreadTerm MCP override');
  const child = spawn(command, parseTomlList(rawArgs), { windowsHide: true, env: { ...process.env, ...parseEnv(rawEnv) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let serial = 0, buffer = '', queue = [];
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line) queue.push(JSON.parse(line)); } });
  const rpc = async (method, params) => { const id = ++serial; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); for (let n = 0; n < 1000; n += 1) { const found = queue.find(row => row.id === id); if (found) { if (found.error) throw Error(`MCP JSON-RPC ${found.error.code}: ${found.error.message}`); return found.result; } if (child.exitCode !== null) throw Error(`MCP exited during ${method}`); await new Promise(resolve => setTimeout(resolve, 15)); } throw Error(`MCP timeout: ${method}`); };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-browser-qa', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await rpc('tools/list', {}); event('mcp.tools', { names: tools.tools?.map(tool => tool.name) });
  const response = await rpc('tools/call', { name, arguments: arguments_ }); child.kill(); return response;
}
let turns = 0; const nativeId = `qa-browser-native-${process.pid}`;
const thread = () => ({ id: nativeId, cwd: process.env.THREADTERM_QA_BROWSER_CWD, status: { type: 'idle' } });
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => { if (!line.trim()) return; const request = JSON.parse(line); if (request.id === undefined) return; const { id, method, params = {} } = request;
  if (method === 'initialize') return result(id, { capabilities: {} }); if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false }); if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'model/list') return result(id, { data: [{ id: 'qa-browser', displayName: 'QA Browser', supportedReasoningEfforts: [] }] }); if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/read') return result(id, { thread: thread(), threadSettings: { model: 'qa-browser', approvalPolicy: 'on-request' } });
  if (method === 'turn/start') { const turn = `qa-browser-turn-${++turns}`, input = params.input?.map(item => item.text ?? '').join(' ') ?? ''; let control = {}; try { control = JSON.parse(input.replace(/^qa-preview\s*/,'') || '{}'); } catch {} const requestId = control.requestId ?? `codex-${turns}`, suffix = control.path ?? 'codex'; notice('turn/started', { threadId: nativeId, turn: { id: turn } }); result(id, { turn: { id: turn } }); try { if (Number.isInteger(control.delayMs)) await new Promise(done => setTimeout(done, Math.min(10_000, Math.max(0, control.delayMs)))); const call = await mcpCall('preview_present', { requestId, url: `${process.env.THREADTERM_QA_BROWSER_URL}/${suffix}`, title: control.title ?? 'Codex preview' }); const text = call?.content?.[0]?.text; let parsed; try { parsed = JSON.parse(text); } catch {} event('mcp.present', { requestId, isError: call?.isError === true, resultKeys: Object.keys(call ?? {}), state: parsed?.state, navigation: parsed?.navigation, errorCode: parsed?.error?.code }); notice('item/completed', { threadId: nativeId, turnId: turn, item: { id: `${turn}-answer`, type: 'agentMessage', text: 'PREVIEW_REQUESTED' } }); } catch (error) { event('mcp.error', { message: String(error).slice(0, 300) }); notice('item/completed', { threadId: nativeId, turnId: turn, item: { id: `${turn}-error`, type: 'agentMessage', text: `PREVIEW_ERROR ${error.message}` } }); } notice('turn/completed', { threadId: nativeId, turn: { id: turn, status: 'completed' } }); return; }
  if (method === 'turn/interrupt') return result(id, {}); result(id, {});
});
