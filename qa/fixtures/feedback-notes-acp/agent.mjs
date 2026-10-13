#!/usr/bin/env node
// Local-only E2 ACP fixture. It receives the per-session MCP server through
// ACP, announces that it is waiting, then the QA user sends a note through the
// split Send. Once a marker file appears it calls feedback_check mid-turn and
// reports the exact notes it received. No provider binary is started.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let serial = 0;
const servers = new Map();
const cwds = new Map();

async function callTool(server, name, args) {
  const env = Array.isArray(server.env) ? Object.fromEntries(server.env.map(({ name, value }) => [name, value])) : server.env || {};
  const child = spawn(server.command, server.args || [], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let rest = '';
  const wait = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    rest += chunk;
    for (;;) {
      const cut = rest.indexOf('\n');
      if (cut < 0) return;
      const row = JSON.parse(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
      const done = wait.get(row.id);
      wait.delete(row.id);
      done?.(row);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial;
    wait.set(id, row => row.error ? reject(Error(row.error.message)) : resolve(row.result));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'feedback-notes-qa', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await rpc('tools/list', {});
    if (!listed.tools?.some(tool => tool.name === name)) throw Error(`${name} missing from MCP catalog`);
    return await rpc('tools/call', { name, arguments: args || {} });
  } finally {
    child.kill();
  }
}

const sleep = ms => new Promise(done => setTimeout(done, ms));
async function waitForNote(cwd) {
  const marker = join(cwd, '.qa-note-sent');
  for (let index = 0; index < 300; index++) {
    if (existsSync(marker)) return true;
    await sleep(100);
  }
  return false;
}

if (process.argv.includes('--version')) console.log('feedback-notes-echo 1.0.0');
else if (process.argv.includes('--acp')) createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = request;
  const reply = result => send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: {} } });
  if (method === 'initialized') return;
  if (method === 'session/new' || method === 'session/load') {
    const sessionId = method === 'session/new' ? `feedback-notes-${Date.now()}` : params.sessionId;
    servers.set(sessionId, params.mcpServers?.[0]);
    cwds.set(sessionId, params.cwd || process.cwd());
    return reply({ sessionId });
  }
  if (method === 'session/prompt') {
    const sessionId = params.sessionId;
    const server = servers.get(sessionId);
    const cwd = cwds.get(sessionId) || process.cwd();
    const chunk = text => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    try {
      chunk('WAITING_FOR_NOTE');
      const ready = await waitForNote(cwd);
      chunk(ready ? 'NOTE_READY' : 'NOTE_TIMEOUT');
      const result = await callTool(server, 'feedback_check', {});
      chunk(`NOTE_RESULT ${JSON.stringify(result)}`);
    } catch (error) {
      chunk(`NOTE_ERROR ${error.message}`);
    }
    return reply({});
  }
  if (method === 'session/cancel') return reply({});
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported ${method}` } });
});
