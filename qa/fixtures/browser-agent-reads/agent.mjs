import { createInterface } from 'node:readline';
import helpers from './mcp.cjs';
const { client, control, run, log } = helpers;
const send = value => process.stdout.write(JSON.stringify(value) + '\n'), sessions = new Map();
if (process.argv.includes('--version')) { console.log('browser-agent-reads-acp-qa 1.0.0'); process.exit(0); }
const emit = (sessionId, update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = request, reply = result => send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: {} } });
  if (method === 'session/new' || method === 'session/load') { const sessionId = params.sessionId || `browser-agent-reads-acp-${process.pid}`; sessions.set(sessionId, { entry: params.mcpServers?.find(server => server.name === 'threadterm') || params.mcpServers?.[0] }); return reply({ sessionId }); }
  if (method === 'session/cancel') { sessions.get(params.sessionId)?.host?.cancel(); return reply({}); }
  if (method !== 'session/prompt') { if (id !== undefined) reply({}); return; }
  try {
    const session = sessions.get(params.sessionId); session.host ||= client(session.entry);
    const plan = control(params.prompt?.map(part => part.text || '').join(' ') || ''); let number = 0, toolId;
    const results = await run(plan, session.host, (name, args) => { toolId = `${plan.id}-tool-${++number}`; emit(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: toolId, title: name, kind: 'fetch', status: 'running', rawInput: args }); }, (_name, _args, response) => emit(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: toolId, status: response.isError ? 'failed' : 'completed', rawOutput: response }));
    emit(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `BROWSER_QA_RESULT ${JSON.stringify({ id: plan.id, results })}` } }); reply({ stopReason: 'end_turn' });
  } catch (error) { log('acp.error', { message: String(error.message).slice(0, 300) }); emit(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `BROWSER_QA_ERROR ${String(error.message).slice(0, 300)}` } }); reply({ stopReason: 'end_turn' }); }
});
