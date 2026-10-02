// Real Claude terminal launch verification (fix package A, issue 1).
// Isolated runtime data/pipe; the REAL installed Claude CLI; cwd must be a
// directory the user has already trusted in Claude (no prompt is approved by
// this script). No Enter is ever sent, so no model request can be made.
//   node qa/claude-terminal-launch.mjs
// Optional: THREADTERM_QA_CLAUDE_CWD overrides the trusted cwd.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import xterm from '@xterm/xterm';
import { connectPeer } from './pipe-client.mjs';
const { Terminal } = xterm;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exe = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target/debug/threadterm-v3-runtime.exe');
const cwd = process.env.THREADTERM_QA_CLAUDE_CWD ?? 'D:/project/ThreadTerm/ThreadTerm';
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-claude-launch-'));
const data = join(scratch, 'data');
const pipe = `\\\\.\\pipe\\threadterm-claude-launch-${randomUUID()}`;
const checks = [];
const note = text => { checks.push(text); console.log(`PASS ${text}`); };
let daemon;
const peers = new Set();

async function connect() {
  const p = await connectPeer(`${pipe}-control`);
  await p.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
  const request = p.request.bind(p);
  p.request = (method, params = {}, timeoutMs = 60000) => request(method, params, timeoutMs);
  peers.add(p);
  return p;
}
async function start() {
  await import('node:fs/promises').then(fs => fs.mkdir(data, { recursive: true }));
  daemon = spawn(exe, [], { windowsHide: true, env: { ...process.env, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'user-data'), THREADTERM_V3_PIPE: pipe }, stdio: 'ignore' });
  for (let i = 0; i < 150; i++) {
    try { return await connect(); }
    catch { if (daemon.exitCode !== null || daemon.signalCode !== null) throw Error('daemon exited at startup'); await delay(100); }
  }
  throw Error('runtime startup timeout');
}
async function output(peer, id) {
  const result = await peer.request('terminal.read', { sessionId: id, cursor: 0, limit: 1048576 }, 60000);
  return Buffer.from(result.data, 'base64').toString();
}
async function visibleScreen(peer, id, cols = 80, rows = 24) {
  const page = await peer.request('terminal.read', { sessionId: id, cursor: 0, limit: 1048576 });
  const term = new Terminal({ cols, rows, scrollback: 1000 });
  try {
    await new Promise(resolve => term.write(Buffer.from(page.data, 'base64'), resolve));
    const buffer = term.buffer.active;
    return Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '').join('\n');
  } finally { term.dispose(); }
}
async function waitFor(fn, message, ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(300); }
  throw Error(message);
}
async function send(peer, id, text) {
  const { leaseEpoch } = await peer.request('session.claim', { sessionId: id, clientId: 'qa-claude-launch' });
  try { await peer.request('terminal.input', { sessionId: id, data: text, leaseEpoch }); }
  finally { await peer.request('session.release', { sessionId: id, leaseEpoch }).catch(() => {}); }
}

try {
  let peer = await start();
  const caps = (await peer.request('runtime.snapshot')).providers;
  const claude = caps.find(p => p.id === 'claude');
  assert.ok(claude?.installed, `Claude must probe as installed through the fixed script launch: ${JSON.stringify(claude)}`);
  assert.ok(claude.version?.length > 0, 'Claude version probe must succeed through the script wrapper');
  note(`capability: claude installed, version=${claude.version}`);

  const s = await peer.request('session.create', { cwd, title: 'QA claude launch', provider: 'claude', mode: 'terminal', operationId: randomUUID() }, 90000);
  assert.ok(s.nativeId, 'claude native identity must be pre-assigned before launch');
  assert.equal(s.status, 'running');
  note(`created: session=${s.id} native=${s.nativeId}`);

  const firstText = await waitFor(async () => {
    const text = await output(peer, s.id);
    if (/trust|信任|Yes, continue/i.test(text)) throw Error('native trust prompt appeared; this script never approves prompts (choose a trusted THREADTERM_QA_CLAUDE_CWD)');
    return /❯|>|for shortcuts|Claude/i.test(text) && text;
  }, 'Claude native UI did not render');
  note('native Claude interface rendered');

  // Type without submitting: the marker must echo; Ctrl+U must clear it.
  const marker = `TT-PROBE-${randomUUID().slice(0, 8)}`;
  await send(peer, s.id, marker);
  await waitFor(async () => (await output(peer, s.id)).includes(marker), 'unsubmitted input did not echo');
  await waitFor(async () => (await visibleScreen(peer, s.id)).includes(marker), 'unsubmitted input did not render');
  note('unsubmitted input echoed in the native input field');
  const beforeBackspace = (await peer.request('terminal.read', { sessionId: s.id, tail: true, limit: 1 })).nextCursor;
  await send(peer, s.id, '\x7f');
  const backspaceOutput = await waitFor(async () => {
    const chunk = await peer.request('terminal.read', { sessionId: s.id, cursor: beforeBackspace, limit: 1048576 });
    return chunk.nextCursor > beforeBackspace && Buffer.from(chunk.data, 'base64').toString();
  }, 'native Claude did not redraw after Backspace', 15000);
  await waitFor(async () => {
    const screen = await visibleScreen(peer, s.id);
    return screen.includes(marker.slice(0, -1)) && !screen.includes(marker);
  }, 'native Claude Backspace did not remove the last character from its rendered input', 15000);
  note(`native Backspace removed the last character (DEL; ${Buffer.byteLength(backspaceOutput)} redraw bytes)`);
  await send(peer, s.id, '\x15');
  await delay(700);
  // A cleared line redraws without the old text: typing a second marker must
  // not produce a line where the first marker precedes it again.
  const cursorBeforeSecond = (await peer.request('terminal.read', { sessionId: s.id, cursor: 0, limit: 1048576 }, 60000)).nextCursor;
  const second = `TT-PROBE-${randomUUID().slice(0, 8)}`;
  await send(peer, s.id, second);
  await waitFor(async () => {
    const chunk = await peer.request('terminal.read', { sessionId: s.id, cursor: cursorBeforeSecond, limit: 1048576 }, 60000);
    return Buffer.from(chunk.data, 'base64').toString().includes(second);
  }, 'second unsubmitted input did not echo');
  const afterClear = await peer.request('terminal.read', { sessionId: s.id, cursor: cursorBeforeSecond, limit: 1048576 }, 60000);
  const redrawn = Buffer.from(afterClear.data, 'base64').toString();
  assert.ok(!redrawn.includes(marker), 'Ctrl+U did not clear the input: the first marker was redrawn before the second');
  await send(peer, s.id, '\x15');
  await delay(500);
  note('Ctrl+U cleared the input; nothing was submitted');

  if (process.env.THREADTERM_QA_INPUT_ONLY === '1') {
    await peer.request('session.stop', { sessionId: s.id, force: true, operationId: randomUUID() });
    note('input-only probe ended without submitting a model request');
    console.log(JSON.stringify({ passed: true, checks, scratch }));
  } else {

  // Stop the CLI, restart the runtime, and resume the exact native identity.
  await peer.request('session.stop', { sessionId: s.id, force: true, operationId: randomUUID() });
  await peer.request('runtime.shutdown', { operationId: randomUUID() });
  for (let i = 0; daemon.exitCode === null && daemon.signalCode === null && i < 200; i++) await delay(100);
  for (const p of peers) p.close(); peers.clear();
  peer = await start();
  let record = (await peer.request('runtime.snapshot')).sessions.find(x => x.id === s.id);
  assert.equal(record.nativeId, s.nativeId, 'identity lost across runtime restart');
  assert.ok(['exited', 'interrupted'].includes(record.status));
  const resumeCursor = (await peer.request('terminal.read', { sessionId: s.id, cursor: 0, limit: 1048576 }, 60000)).nextCursor;
  const resumed = await peer.request('session.resume', { sessionId: s.id, operationId: randomUUID() }, 90000);
  assert.equal(resumed.id, s.id);
  assert.equal(resumed.nativeId, s.nativeId);
  const resumedSession = await waitFor(async () => {
    const item = (await peer.request('runtime.snapshot')).sessions.find(x => x.id === s.id);
    return item.status === 'running' ? item : null;
  }, 'resumed Claude terminal did not stay running', 30000);
  assert.equal(resumedSession.nativeId, s.nativeId);
  await waitFor(async () => {
    const chunk = await peer.request('terminal.read', { sessionId: s.id, cursor: resumeCursor, limit: 1048576 }, 60000);
    const text = Buffer.from(chunk.data, 'base64').toString();
    if (/No conversation found with session ID:/i.test(text)) {
      throw Error('Claude did not persist this empty native conversation; resume cannot be verified without a submitted turn');
    }
    if (/trust|信任|Yes, continue/i.test(text)) throw Error('resumed native trust prompt appeared; QA does not approve prompts');
    return /❯|for shortcuts/i.test(text);
  }, 'resumed Claude native input did not render', 30000);
  const resumedEchoCursor = (await peer.request('terminal.read', { sessionId: s.id, cursor: 0, limit: 1048576 }, 60000)).nextCursor;
  const resumedMarker = `TT-RESUME-${randomUUID().slice(0, 8)}`;
  await send(peer, s.id, resumedMarker);
  await waitFor(async () => {
    const chunk = await peer.request('terminal.read', { sessionId: s.id, cursor: resumedEchoCursor, limit: 1048576 }, 60000);
    return Buffer.from(chunk.data, 'base64').toString().includes(resumedMarker);
  }, 'resumed Claude input did not echo an unsubmitted marker', 30000);
  await send(peer, s.id, '\x15');
  note('resume kept the same ThreadTerm/native identity; native input echoed without submitting');

  await peer.request('session.stop', { sessionId: s.id, force: true, operationId: randomUUID() });
  const fresh = await peer.request('session.rerun', { sessionId: s.id, operationId: randomUUID() }, 90000);
  assert.notEqual(fresh.id, s.id);
  assert.notEqual(fresh.nativeId, s.nativeId);
  await peer.request('session.stop', { sessionId: fresh.id, force: true, operationId: randomUUID() });
  note('rerun uses a separate ThreadTerm/native identity');

  console.log(JSON.stringify({ passed: true, checks, scratch }));
  }
} finally {
  for (const p of peers) p.close();
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
  console.log(`QA artifacts: ${scratch}`);
}
