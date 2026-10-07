#!/usr/bin/env node
// Kept independent from other QA fixtures so context-menu runs never share a
// provider id, storage, or discovery state with another real-app acceptance test.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
const sessions = new Map();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const promptText = prompt => Array.isArray(prompt) ? prompt.filter(part => part?.type === 'text').map(part => part.text || '').join('') : '';
if (process.argv.includes('--version')) console.log('context-menus-echo-acp 0.1.0');
else if (process.argv.includes('login')) console.log('Echo needs no sign-in.');
else if (process.argv.includes('--acp')) createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = request;
  const reply = result => send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {} } } });
  if (method === 'initialized') return;
  if (method === 'session/new') { const sessionId = `context-menus-${randomUUID()}`; sessions.set(sessionId, []); return reply({ sessionId }); }
  if (method === 'session/list') return reply({ sessions: [...sessions].map(([sessionId, messages]) => ({ sessionId, title: messages.at(-1)?.text || 'Context menus Echo' })) });
  if (method === 'session/load') { for (const message of sessions.get(params.sessionId) || []) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: message.text } } } }); return reply({ sessionId: params.sessionId }); }
  if (method === 'session/prompt') { const text = promptText(params.prompt); const messages = sessions.get(params.sessionId); if (!messages) return send({ jsonrpc: '2.0', id, error: { code: -32004, message: 'session not found' } }); const answer = `Echo: ${text}`; messages.push({ role: 'user', text }, { role: 'agent', text: answer }); send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } } }); return reply({ stopReason: 'end_turn' }); }
  if (method === 'session/cancel') return reply({});
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } });
});
else createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => console.log(`Echo: ${line}`));
