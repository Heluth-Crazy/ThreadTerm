#!/usr/bin/env node
// Public ACP conformance fixture.  The harness owns the MCP child it receives
// in session/new's normal mcpServers transport; no ThreadTerm provider ID is
// mentioned here.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const log = (event, detail = {}) => process.env.THREADTERM_QA_BROWSER_EVENTS && appendFileSync(process.env.THREADTERM_QA_BROWSER_EVENTS, `${JSON.stringify({ event, detail, pid: process.pid })}\n`);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
let next = 0; const servers = new Map();
async function useMcp(entry, sessionId) {
  const environment = Array.isArray(entry.env) ? Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) : entry.env ?? {};
  const child = spawn(entry.command, entry.args ?? [], { windowsHide: true, env: { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', resolveLine; const line = () => new Promise(resolve => { resolveLine = resolve; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { buffer += chunk; const i = buffer.indexOf('\n'); if (i >= 0 && resolveLine) { const value = buffer.slice(0, i); buffer = buffer.slice(i + 1); const done = resolveLine; resolveLine = undefined; done(JSON.parse(value)); } });
  const rpc = async (method, params) => { const id = ++next; child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); for (;;) { const row = await line(); if (row.id === id) return row.result; } };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-preview-acp-qa', version: '1' } }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listed = await rpc('tools/list', {}); log('mcpTools', { names: listed.tools?.map(tool => tool.name) });
  const call = await rpc('tools/call', { name: 'preview_present', arguments: { requestId: `acp-${sessionId}`, url: `${process.env.THREADTERM_QA_BROWSER_URL}/acp`, title: 'ACP preview' } });
  log('previewResult', { call }); child.kill(); return call;
}
if (process.argv.includes('--version')) { console.log('browser-preview-acp-qa 1.0.0'); process.exit(0); }
if (!process.argv.includes('--acp')) process.exit(0);
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async raw => { let request; try { request = JSON.parse(raw); } catch { return; } const { id, method, params = {} } = request; log('request', { method, mcpServerNames: Array.isArray(params.mcpServers) ? params.mcpServers.map(item => item?.name).filter(Boolean) : [] });
  if (method === 'initialize') return reply(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: {} } });
  if (method === 'initialized') return;
  if (method === 'session/new' || method === 'session/load') { const sessionId = method === 'session/new' ? `browser-preview-acp-${process.pid}` : params.sessionId; servers.set(sessionId, Array.isArray(params.mcpServers) ? params.mcpServers[0] : undefined); return reply(id, { sessionId }); }
  if (method === 'session/prompt') { const entry = servers.get(params.sessionId); const result = entry ? await useMcp(entry, params.sessionId) : { missing: true }; notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ACP preview result: ${JSON.stringify(result)}` } } }); return reply(id, {}); }
  if (method === 'session/cancel') return reply(id, {});
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported ${method}` } });
});
