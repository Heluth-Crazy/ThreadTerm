#!/usr/bin/env node
// Isolated ACP agent for the B2/B3 tool-card real-app QA. One prompt produces a
// read, a search, a failed command with output/exit code, and a two-file edit,
// then a short final answer. It never contacts a model or the network.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const sessions = new Map();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);

const READ_PATH = 'src/app.ts';
const EDIT_FILES = [
  { path: 'src/app.ts', oldText: 'const version = 1;\n', newText: 'const version = 2;\n' },
  { path: 'src/new.ts', oldText: '', newText: 'export const added = true;\n' },
];

function emit(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

function toolCall(sessionId, toolCallId, fields) {
  emit(sessionId, { sessionUpdate: 'tool_call', toolCallId, status: 'running', ...fields });
}

function toolUpdate(sessionId, toolCallId, fields) {
  emit(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, ...fields });
}

function runTurn(sessionId, reply) {
  toolCall(sessionId, 'tc-read', {
    title: `Read ${READ_PATH}`,
    kind: 'read',
    locations: [{ path: READ_PATH, line: 1 }],
    rawInput: { file_path: READ_PATH, offset: 1, limit: 40 },
  });
  toolUpdate(sessionId, 'tc-read', { status: 'completed', rawInput: { file_path: READ_PATH, offset: 1, limit: 40 } });

  toolCall(sessionId, 'tc-search', {
    title: 'Search',
    kind: 'search',
    rawInput: { pattern: 'describeTool', path: 'renderer/src' },
  });
  toolUpdate(sessionId, 'tc-search', {
    status: 'completed',
    rawInput: { pattern: 'describeTool', path: 'renderer/src' },
    rawOutput: { content: [{ type: 'text', text: '3 matches in 2 files' }] },
  });

  toolCall(sessionId, 'tc-exec', {
    title: 'Execute',
    kind: 'execute',
    rawInput: { command: 'npm run typecheck' },
    content: [{ type: 'terminal', terminalId: 'tc-exec-terminal' }],
  });
  toolUpdate(sessionId, 'tc-exec', {
    status: 'failed',
    kind: 'execute',
    rawInput: { command: 'npm run typecheck' },
    exitCode: 1,
    rawOutput: { content: [{ type: 'text', text: 'error TS2322: Type string is not assignable to type number.' }] },
  });

  toolCall(sessionId, 'tc-edit', {
    title: 'Edit two files',
    kind: 'edit',
    rawInput: { files: EDIT_FILES.map(file => file.path) },
  });
  toolUpdate(sessionId, 'tc-edit', {
    status: 'completed',
    kind: 'edit',
    content: EDIT_FILES.map(file => ({ type: 'diff', path: file.path, oldText: file.oldText, newText: file.newText })),
  });

  emit(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Tool-card fixture complete.' } });
  reply({ stopReason: 'end_turn' });
}

if (process.argv.includes('--version')) {
  console.log('tool-cards-echo-acp 0.1.0');
} else if (process.argv.includes('login')) {
  console.log('Echo needs no sign-in.');
} else if (process.argv.includes('--acp')) {
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    const { id, method, params = {} } = request;
    const reply = result => send({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {} } } });
    if (method === 'initialized') return;
    if (method === 'session/new') {
      const sessionId = `tool-cards-${randomUUID()}`;
      sessions.set(sessionId, []);
      return reply({ sessionId });
    }
    if (method === 'session/list') return reply({ sessions: [...sessions].map(([sessionId]) => ({ sessionId, title: 'Tool cards Echo' })) });
    if (method === 'session/load') return reply({ sessionId: params.sessionId });
    if (method === 'session/prompt') {
      const messages = sessions.get(params.sessionId);
      if (!messages) return send({ jsonrpc: '2.0', id, error: { code: -32004, message: 'session not found' } });
      messages.push({ role: 'agent', text: 'Tool-card fixture complete.' });
      return runTurn(params.sessionId, reply);
    }
    if (method === 'session/cancel') return reply({});
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } });
  });
} else {
  console.log('Tool cards Echo terminal.');
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => console.log(`Echo: ${line}`));
}
