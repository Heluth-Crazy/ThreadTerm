#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'echo-acp 0.1.0';
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)));
// A plugin installation gets its own local store. This lets short-lived ACP
// processes resume sessions without placing mutable files in the plugin folder.
const storeRoot = process.env.THREADTERM_ECHO_STORE_DIR
  ? resolve(process.env.THREADTERM_ECHO_STORE_DIR)
  : join(tmpdir(), 'threadterm-echo-acp', createHash('sha256').update(pluginRoot).digest('hex').slice(0, 24));

function sessionPath(id) {
  return join(storeRoot, `${id}.json`);
}

async function save(session) {
  await mkdir(storeRoot, { recursive: true });
  const target = sessionPath(session.id);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

function load(id) {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id) || !existsSync(sessionPath(id))) return null;
  try {
    const value = JSON.parse(readFileSync(sessionPath(id), 'utf8'));
    return value && value.id === id && Array.isArray(value.messages) ? value : null;
  } catch {
    return null;
  }
}

function sessions() {
  if (!existsSync(storeRoot)) return [];
  // Node has no async need here; a small example store is intentionally simple.
  return readdirSync(storeRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => load(entry.name.slice(0, -5)))
    .filter(Boolean)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function promptText(prompt) {
  return Array.isArray(prompt)
    ? prompt.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
    : '';
}

function runAcp() {
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const update = (sessionId, sessionUpdate, text) => send({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId, update: { sessionUpdate, content: { type: 'text', text } },
    },
  });

  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
    if (!line.trim()) return;
    let request;
    try { request = JSON.parse(line); } catch { return; }
    const { id, method, params = {} } = request;
    try {
      if (method === 'initialize') {
        reply(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {} } } });
      } else if (method === 'initialized') {
        // ACP notification; no response is required.
      } else if (method === 'session/new') {
        const now = new Date().toISOString();
        const session = { id: `echo-${randomUUID()}`, cwd: typeof params.cwd === 'string' ? params.cwd : undefined, createdAt: now, updatedAt: now, messages: [] };
        await save(session);
        reply(id, { sessionId: session.id });
      } else if (method === 'session/list') {
        reply(id, { sessions: sessions().map(session => ({ sessionId: session.id, cwd: session.cwd, title: session.messages.at(-1)?.text || 'Echo session', updatedAt: session.updatedAt })) });
      } else if (method === 'session/load') {
        const session = load(params.sessionId);
        if (!session) fail(id, -32004, 'Echo session was not found');
        else {
          for (const message of session.messages) update(session.id, message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', message.text);
          reply(id, { sessionId: session.id });
        }
      } else if (method === 'session/prompt') {
        const session = load(params.sessionId);
        if (!session) fail(id, -32004, 'Echo session was not found');
        else {
          const text = promptText(params.prompt);
          const answer = `Echo: ${text}`;
          session.messages.push({ role: 'user', text }, { role: 'agent', text: answer });
          session.updatedAt = new Date().toISOString();
          await save(session);
          update(session.id, 'agent_message_chunk', answer);
          reply(id, { stopReason: 'end_turn' });
        }
      } else if (method === 'session/cancel') {
        if (id !== undefined) reply(id, {});
      } else if (id !== undefined) {
        fail(id, -32601, `Unsupported method: ${method}`);
      }
    } catch (error) {
      if (id !== undefined) fail(id, -32000, error instanceof Error ? error.message : String(error));
    }
  });
}

async function runTerminal(resumeId) {
  if (resumeId) {
    const session = load(resumeId);
    if (session) for (const message of session.messages) console.log(`${message.role === 'user' ? 'You' : 'Echo'}: ${message.text}`);
    else console.log(`Echo session ${resumeId} was not found.`);
  }
  console.log('Echo terminal. Type a line and press Enter; Ctrl+C exits.');
  const input = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  input.prompt();
  input.on('line', line => { console.log(`Echo: ${line}`); input.prompt(); });
}

if (process.argv.includes('--version')) console.log(VERSION);
else if (process.argv.includes('login')) console.log('Echo needs no sign-in.');
else if (process.argv.includes('--acp')) runAcp();
else {
  const resume = process.argv.indexOf('--resume');
  runTerminal(resume >= 0 ? process.argv[resume + 1] : undefined);
}
