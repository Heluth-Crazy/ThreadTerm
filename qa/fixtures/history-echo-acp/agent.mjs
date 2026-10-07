#!/usr/bin/env node
// ACP history fixture. The QA owns its data file so each run is isolated.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const historyFile = process.env.THREADTERM_QA_HISTORY_FILE;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32004, message } });
function records() {
  if (!historyFile) return [];
  try { const value = JSON.parse(readFileSync(historyFile, 'utf8')); return Array.isArray(value.sessions) ? value.sessions : []; } catch { return []; }
}
function find(id) { return records().find(session => session.sessionId === id); }
function update(sessionId, entry) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: entry.sessionUpdate, ...entry } } }); }

if (process.argv.includes('--version')) console.log('history-echo-acp 0.1.0');
else if (process.argv.includes('login')) console.log('History Echo needs no sign-in.');
else if (process.argv.includes('--acp')) createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = request;
  if (method === 'initialize') return reply(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {} } } });
  if (method === 'initialized') return;
  if (method === 'session/list') return reply(id, { sessions: records().map(({ sessionId, cwd, title, updatedAt }) => ({ sessionId, cwd, title, updatedAt })) });
  if (method === 'session/load') {
    const session = find(params.sessionId);
    if (!session) return fail(id, 'History session was not found');
    for (const entry of session.updates || []) update(session.sessionId, entry);
    return reply(id, { sessionId: session.sessionId });
  }
  if (method === 'session/new') return reply(id, { sessionId: 'history-new-session' });
  if (method === 'session/cancel') return reply(id, {});
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } });
});
else console.log('History Echo terminal fixture.');
