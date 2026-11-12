#!/usr/bin/env node
// Local-only ACP fixture for the live Chat activity QA. The pauses make each
// transcript boundary observable without a model, network, or real agent CLI.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const sessions = new Set();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const emit = (sessionId, update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
const later = (milliseconds, fn) => setTimeout(fn, milliseconds);

function runTurn(sessionId, reply) {
  emit(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'live-read', title: 'Read live fixture', kind: 'read', status: 'running', rawInput: { file_path: 'live-fixture.ts' } });
  emit(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'live-read', title: 'Read live fixture', status: 'completed', rawOutput: { content: [{ type: 'text', text: 'fixture read complete' }] } });
  emit(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First live update.' } });
  // Codex-style reasoning before each call: thinking must not split the second drawer.
  later(2500, () => {
    emit(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Searching the fixture next.' } });
    emit(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'live-search', title: 'Search live fixture', kind: 'search', status: 'running', rawInput: { pattern: 'live activity' } });
    later(2500, () => {
      emit(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'live-search', title: 'Search live fixture', status: 'completed', rawOutput: { content: [{ type: 'text', text: 'fixture search complete' }] } });
      emit(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'One more check before replying.' } });
      later(1500, () => {
        emit(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'live-list', title: 'List live fixture', kind: 'read', status: 'running', rawInput: { path: '.' } });
        later(2500, () => {
          emit(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'live-list', title: 'List live fixture', status: 'completed', rawOutput: { content: [{ type: 'text', text: 'fixture list complete' }] } });
          emit(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second live update.' } });
          later(6000, () => reply({ stopReason: 'end_turn' }));
        });
      });
    });
  });
}

if (process.argv.includes('--version')) console.log('chat-live-activity 1.0.0');
else if (process.argv.includes('--acp')) createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = request;
  const reply = result => send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {} } } });
  if (method === 'initialized') return;
  if (method === 'session/new') { const sessionId = `chat-live-${randomUUID()}`; sessions.add(sessionId); return reply({ sessionId }); }
  if (method === 'session/list') return reply({ sessions: [...sessions].map(sessionId => ({ sessionId, title: 'Chat live activity' })) });
  if (method === 'session/load') return reply({ sessionId: params.sessionId });
  if (method === 'session/prompt') return runTurn(params.sessionId, reply);
  if (method === 'session/cancel') return reply({});
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } });
});
