#!/usr/bin/env node
// Copy of qa/fixtures/prompt-queue-echo-acp/agent.mjs. Its QA-only addition
// emits deterministic independent-review findings for a review prompt.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'agent-review-echo 0.1.0';
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const storeRoot = process.env.THREADTERM_ECHO_STORE_DIR ? resolve(process.env.THREADTERM_ECHO_STORE_DIR) : join(tmpdir(), 'threadterm-agent-review-echo', createHash('sha256').update(pluginRoot).digest('hex').slice(0, 24));
function sessionPath(id) { return join(storeRoot, `${id}.json`); }
async function save(session) { await mkdir(storeRoot, { recursive: true }); const target = sessionPath(session.id), temporary = `${target}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, 'utf8'); await rename(temporary, target); }
function load(id) { if (!/^[a-zA-Z0-9-]{1,128}$/.test(id) || !existsSync(sessionPath(id))) return null; try { const value = JSON.parse(readFileSync(sessionPath(id), 'utf8')); return value && value.id === id && Array.isArray(value.messages) ? value : null; } catch { return null; } }
function sessions() { if (!existsSync(storeRoot)) return []; return readdirSync(storeRoot, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => load(entry.name.slice(0, -5))).filter(Boolean).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)); }
function promptText(prompt) { return Array.isArray(prompt) ? prompt.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : ''; }
function reviewedPath(text) { const patch = /^\+\+\+ b\/(.+)$/m.exec(text)?.[1]?.trim(); if (patch && patch !== '/dev/null') return patch; return /^diff --git a\/(.+?) b\/(.+)$/m.exec(text)?.[2]?.trim() || 'src/review-target.ts'; }
function reviewAnswer(text) {
  if (text.includes('INVALID-REVIEW-MARKER')) return 'Review completed, but this fixture intentionally returned no findings block.';
  const path = reviewedPath(text), line = Number(/@@ [^\r\n]*\+(\d+)/.exec(text)?.[1] || 1);
  return `Review complete.\n\n\`\`\`threadterm-review\n${JSON.stringify([{ severity: 'high', path, line, title: 'Changed behavior needs a regression test', body: 'The changed line needs a test that preserves this review snapshot.' }, { severity: 'info', title: 'General follow-up', body: 'Consider documenting the user-visible behavior.' }, { severity: 'low', path: '../outside.txt', line: 1, title: 'Escaping path is made general', body: 'The runtime must reject paths outside the reviewed worktree.' }])}\n\`\`\``;
}
function runAcp() {
  const pending = new Map();
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const update = (sessionId, sessionUpdate, text) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate, content: { type: 'text', text } } } });
  const complete = async (turn, suffix = '') => {
    if (!pending.delete(turn.key)) return;
    const session = load(turn.sessionId); if (!session) return fail(turn.requestId, -32004, 'Echo session was not found');
    const answer = turn.text.includes('threadterm-review') ? reviewAnswer(turn.text) : `Echo: ${turn.text}${suffix}`;
    session.messages.push({ role: 'user', text: turn.text }, { role: 'agent', text: answer }); session.updatedAt = new Date().toISOString();
    await save(session); update(session.id, 'agent_message_chunk', answer); reply(turn.requestId, { stopReason: 'end_turn' });
  };
  const cancel = turn => { clearTimeout(turn.timer); if (pending.delete(turn.key)) reply(turn.requestId, { stopReason: 'cancelled' }); };
  const delayFor = text => Math.min(Math.max(Number(/^slow:(\d+)\b/i.exec(text)?.[1] ?? 0), 0), 15_000);
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
    if (!line.trim()) return; let request; try { request = JSON.parse(line); } catch { return; }
    const { id, method, params = {} } = request;
    try {
      if (method === undefined && id !== undefined) { for (const turn of pending.values()) if (turn.approvalId === id) { await complete(turn, request.error ? ' (denied)' : ' (approved)'); return; } return; }
      if (method === 'initialize') reply(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {} } } });
      else if (method === 'initialized') { /* ACP notification */ }
      else if (method === 'session/new') { const now = new Date().toISOString(), session = { id: `review-echo-${randomUUID()}`, cwd: typeof params.cwd === 'string' ? params.cwd : undefined, createdAt: now, updatedAt: now, messages: [] }; await save(session); reply(id, { sessionId: session.id }); }
      else if (method === 'session/list') reply(id, { sessions: sessions().map(session => ({ sessionId: session.id, cwd: session.cwd, title: session.messages.at(-1)?.text || 'Review Echo session', updatedAt: session.updatedAt })) });
      else if (method === 'session/load') { const session = load(params.sessionId); if (!session) fail(id, -32004, 'Echo session was not found'); else { for (const message of session.messages) update(session.id, message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', message.text); reply(id, { sessionId: session.id }); } }
      else if (method === 'session/prompt') { const session = load(params.sessionId); if (!session) fail(id, -32004, 'Echo session was not found'); else { const text = promptText(params.prompt), turn = { key: randomUUID(), requestId: id, sessionId: session.id, text, timer: undefined, approvalId: undefined }; pending.set(turn.key, turn); if (/^approval\b/i.test(text)) { turn.approvalId = `qa-approval-${randomUUID()}`; send({ jsonrpc: '2.0', id: turn.approvalId, method: 'session/request_permission', params: { sessionId: session.id, toolCall: { toolCallId: `qa-tool-${turn.key}`, title: 'QA approval required' }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } }); } else turn.timer = setTimeout(() => { void complete(turn); }, delayFor(text)); }
      } else if (method === 'session/cancel') { for (const turn of [...pending.values()]) if (turn.sessionId === params.sessionId) cancel(turn); if (id !== undefined) reply(id, {}); }
      else if (id !== undefined) fail(id, -32601, `Unsupported method: ${method}`);
    } catch (error) { if (id !== undefined) fail(id, -32000, error instanceof Error ? error.message : String(error)); }
  });
}
async function runTerminal(resumeId) { if (resumeId) { const session = load(resumeId); if (session) for (const message of session.messages) console.log(`${message.role === 'user' ? 'You' : 'Echo'}: ${message.text}`); else console.log(`Review Echo session ${resumeId} was not found.`); } console.log('Review Echo terminal. Type a line and press Enter; Ctrl+C exits.'); const input = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' }); input.prompt(); input.on('line', line => { console.log(`Echo: ${line}`); input.prompt(); }); }
if (process.argv.includes('--version')) console.log(VERSION);
else if (process.argv.includes('login')) console.log('Review Echo needs no sign-in.');
else if (process.argv.includes('--acp')) runAcp();
else { const resume = process.argv.indexOf('--resume'); runTerminal(resume >= 0 ? process.argv[resume + 1] : undefined); }
