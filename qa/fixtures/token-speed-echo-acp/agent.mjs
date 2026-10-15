#!/usr/bin/env node
// Deterministic, offline ACP fixture for the token-speed Desktop QA.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import scenario from './scenario.json' with { type: 'json' };

export const TOKEN_SPEED_ACP_SCENARIO = scenario;

const sessions = new Map();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const emit = (sessionId, update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });

async function stream(sessionId, chunks, durationMs) {
  const interval = durationMs / chunks.length;
  for (const chunk of chunks) {
    emit(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
    await wait(interval);
  }
}

async function runTurn(sessionId) {
  await wait(scenario.firstTokenMs);
  await stream(sessionId, scenario.firstChunks, scenario.firstStreamMs);
  const toolCallId = 'token-speed-wait';
  emit(sessionId, { sessionUpdate: 'tool_call', toolCallId, status: 'running', title: 'Measured fixture tool', kind: 'execute', rawInput: { command: 'token-speed-fixture wait' } });
  await wait(scenario.toolMs);
  emit(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { content: [{ type: 'text', text: 'fixture tool complete' }] } });
  await stream(sessionId, scenario.secondChunks, scenario.secondStreamMs);
}

function startAcp() {
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    const { id, method, params = {} } = request;
    const reply = result => send({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {} } } });
    if (method === 'initialized') return;
    if (method === 'session/new') {
      const sessionId = `token-speed-${randomUUID()}`;
      sessions.set(sessionId, true);
      return reply({ sessionId });
    }
    if (method === 'session/list') return reply({ sessions: [...sessions.keys()].map(sessionId => ({ sessionId, title: 'Token speed Echo' })) });
    if (method === 'session/load') return sessions.has(params.sessionId) ? reply({ sessionId: params.sessionId }) : send({ jsonrpc: '2.0', id, error: { code: -32004, message: 'session not found' } });
    if (method === 'session/prompt') {
      if (!sessions.has(params.sessionId)) return send({ jsonrpc: '2.0', id, error: { code: -32004, message: 'session not found' } });
      await runTurn(params.sessionId);
      return reply({ stopReason: 'end_turn' });
    }
    if (method === 'session/cancel') return reply({});
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes('--version')) console.log('token-speed-echo-acp 1.0.0');
  else if (process.argv.includes('login')) console.log('Token speed Echo needs no sign-in.');
  else if (process.argv.includes('--acp')) startAcp();
  else console.log('Token speed Echo terminal.');
}
