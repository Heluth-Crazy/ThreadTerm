#!/usr/bin/env node
// Dedicated ACP echo fixture for the Chat reply-copy real-app QA. It answers
// every prompt with one fixed Markdown body so the copy assertions are exact,
// and it never touches the network or a real agent CLI.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
const sessions = new Map();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const ANSWER = '# Reply\n\nThe copy action writes the reply Markdown.\n\n```ts\nconst copied = true;\n```';
if (process.argv.includes('--version')) console.log('reply-copy-echo-acp 0.1.0');
else if (process.argv.includes('login')) console.log('Reply copy Echo needs no sign-in.');
else if (process.argv.includes('--acp')) createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = request;
  const reply = result => send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {} } } });
  if (method === 'initialized') return;
  if (method === 'session/new') { const sessionId = `reply-copy-${randomUUID()}`; sessions.set(sessionId, []); return reply({ sessionId }); }
  if (method === 'session/list') return reply({ sessions: [...sessions].map(([sessionId]) => ({ sessionId, title: 'Reply copy Echo' })) });
  if (method === 'session/load') {
    for (const text of sessions.get(params.sessionId) || []) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    return reply({ sessionId: params.sessionId });
  }
  if (method === 'session/prompt') {
    const messages = sessions.get(params.sessionId);
    if (!messages) return send({ jsonrpc: '2.0', id, error: { code: -32004, message: 'session not found' } });
    messages.push(ANSWER);
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ANSWER } } } });
    return reply({ stopReason: 'end_turn' });
  }
  if (method === 'session/cancel') return reply({});
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } });
});
else createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => console.log(`Echo: ${line}`));
