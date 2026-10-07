#!/usr/bin/env node
// Isolated copy of the prompt-queue Echo ACP fixture. It deliberately echoes
// the entire received text so context serialization is observable in QA.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
const sessions = new Map();
const text = prompt => Array.isArray(prompt) ? prompt.filter(part => part?.type === 'text').map(part => part.text || '').join('') : '';
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (process.argv.includes('--version')) console.log('context-tray-echo-acp 0.1.0');
else if (process.argv.includes('login')) console.log('Echo needs no sign-in.');
else if (process.argv.includes('--acp')) createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = request;
  const reply = result => send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {} } } });
  if (method === 'initialized') return;
  if (method === 'session/new') { const sessionId = `context-${randomUUID()}`; sessions.set(sessionId, []); return reply({ sessionId }); }
  if (method === 'session/list') return reply({ sessions: [...sessions].map(([sessionId, messages]) => ({ sessionId, title: messages.at(-1)?.text || 'Context tray Echo' })) });
  if (method === 'session/load') { for (const message of sessions.get(params.sessionId) || []) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: message.text } } } }); return reply({ sessionId: params.sessionId }); }
  if (method === 'session/prompt') { const value = text(params.prompt); const messages = sessions.get(params.sessionId); if (!messages) return send({ jsonrpc: '2.0', id, error: { code: -32004, message: 'session not found' } }); const complete = () => { const answer = `Echo: ${value}`; messages.push({ role: 'user', text: value }, { role: 'agent', text: answer }); send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } } }); reply({ stopReason: 'end_turn' }); }; const ms = Math.min(Number(/^slow:(\d+)\b/i.exec(value)?.[1] || 0), 15_000); return ms > 0 ? setTimeout(complete, ms) : complete(); }
  if (method === 'session/cancel') return reply({});
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } });
});
else { console.log('Context tray Echo terminal.'); createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => console.log(`Echo: ${line}`)); }
