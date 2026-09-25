// Real CLI acceptance in an isolated runtime/database/project.
// Default: no billed turns. THREADTERM_QA_LIVE=1 also checks NEW assistant
// responses recall a random marker across active application shutdown/crash.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { connectPeer } from './pipe-client.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exe = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target/debug/threadterm-v3-runtime.exe');
const live = process.env.THREADTERM_QA_LIVE === '1';
const selected = (process.env.THREADTERM_QA_PROVIDERS ?? 'codex,kimi,opencode').split(',');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-v3-resume-'));
const data = join(scratch, 'data');
const pipe = `\\\\.\\pipe\\threadterm-v3-resume-${randomUUID()}`;
const peers = new Set(); const checks = [];
let daemon; let peer;
const note = text => { checks.push(text); console.log(`PASS ${text}`); };
async function connect() {
  const p = await connectPeer(`${pipe}-control`);
  try { await p.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim()); }
  catch (error) { p.close(); throw error; }
  const request = p.request.bind(p);
  p.request = (method, params = {}, timeoutMs = 60000) => request(method, params, timeoutMs);
  peers.add(p); return p;
}
async function start() {
  daemon = spawn(exe, [], { windowsHide: true, env: { ...process.env, THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe }, stdio: 'ignore' });
  for (let i = 0; i < 150; i++) {
    try { peer = await connect(); return; }
    catch { if (daemon.exitCode !== null || daemon.signalCode !== null) throw Error('daemon exited at startup'); await delay(100); }
  }
  throw Error('runtime startup timeout');
}
async function restart(kind) {
  if (kind === 'shutdown') await peer.request('runtime.shutdown', { operationId: randomUUID() });
  else daemon.kill();
  for (let i = 0; daemon.exitCode === null && daemon.signalCode === null && i < 200; i++) await delay(100);
  assert.ok(daemon.exitCode !== null || daemon.signalCode !== null, `${kind} failed to stop isolated runtime`);
  for (const p of peers) p.close(); peers.clear();
  await start();
}
const snapshot = () => peer.request('runtime.snapshot');
const session = async id => (await snapshot()).sessions.find(s => s.id === id);
async function output(id) {
  const result = await peer.request('terminal.read', { sessionId: id, cursor: 0, limit: 1048576 });
  return { ...result, text: Buffer.from(result.data, 'base64').toString() };
}
async function waitFor(fn, message, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(300); }
  throw Error(message);
}
async function send(id, text) {
  const { leaseEpoch } = await peer.request('session.claim', { sessionId: id, clientId: 'qa' });
  try { await peer.request('terminal.input', { sessionId: id, data: text, leaseEpoch }); }
  finally { await peer.request('session.release', { sessionId: id, leaseEpoch }).catch(() => {}); }
}
async function settle(id) {
  await waitFor(async () => (await output(id)).text.length > 0, 'terminal produced no output');
  await delay(2500);
  const text = (await output(id)).text;
  assert.equal((await session(id)).status, 'running', `native CLI exited: ${text.slice(-1600)}`);
  if (/trust|信任|Yes, continue/i.test(text)) { await send(id, '\r'); await delay(2500); }
  assert.equal((await session(id)).status, 'running', `native CLI exited: ${text.slice(-1600)}`);
}
async function history(provider, id) { return peer.request('history.read', { provider, nativeId: id }, 60000); }
const assistantText = item => item.role === 'assistant' ? item.parts.filter(p => p.type === 'text').map(p => p.text ?? '').join('') : '';
async function prompt(s, text, expected) {
  const known = new Set((await history(s.provider, s.nativeId)).filter(i => assistantText(i)).map(i => i.id));
  await send(s.id, text); await delay(700); await send(s.id, '\r');
  await waitFor(async () => (await history(s.provider, s.nativeId)).some(i => !known.has(i.id) && assistantText(i).includes(expected)), `${s.provider}: no NEW assistant answer with expected context`, 120000);
}

try {
  await mkdir(data); await start();
  const caps = (await snapshot()).providers;
  for (const provider of selected) {
    assert.ok(caps.find(p => p.id === provider)?.installed, `${provider} is not installed; cannot verify`);
    assert.equal(caps.find(p => p.id === provider)?.terminalResumeCapture, 'preassigned');
    const cwd = join(scratch, provider); await mkdir(cwd);
    const s = await peer.request('session.create', { cwd, title: `QA resume ${provider}`, provider, mode: 'terminal', operationId: randomUUID() }, 90000);
    assert.ok(s.nativeId, `${provider}: native identity must be bound before create returns`);
    await settle(s.id);
    if (['codex', 'kimi', 'opencode'].includes(provider)) await history(provider, s.nativeId);
    note(`${provider}: native identity is bound before input and terminal remains live`);
    const sibling = await peer.request('session.create', { cwd, provider, mode: 'terminal', operationId: randomUUID() }, 90000);
    assert.notEqual(sibling.nativeId, s.nativeId);
    await peer.request('session.stop', { sessionId: sibling.id, force: true, operationId: randomUUID() });
    const token = `TT${randomUUID().replaceAll('-', '').slice(0, 18)}`;
    if (live) await prompt(s, `Remember this session's secret word: ${token}. Do not use tools. Reply only READY.`, 'READY');
    for (const kind of ['shutdown', 'crash']) {
      const before = await output(s.id);
      assert.equal((await session(s.id)).status, 'running');
      // No exitTui/Ctrl+C: quit while the CLI is still live.
      await restart(kind);
      const stopped = await session(s.id);
      assert.ok(['exited', 'interrupted'].includes(stopped.status));
      assert.equal(stopped.nativeId, s.nativeId);
      // Separate authenticated connections: Peer.request is not multiplexed.
      const a = await connect(); const b = await connect();
      const opA = randomUUID(); const opB = randomUUID();
      const results = await Promise.allSettled([
        a.request('session.resume', { sessionId: s.id, operationId: opA }, 90000),
        b.request('session.resume', { sessionId: s.id, operationId: opB }, 90000),
      ]);
      const winner = results.findIndex(r => r.status === 'fulfilled');
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results[1 - winner].reason.code, 'session_already_active');
      assert.equal(results[winner].value.id, s.id);
      assert.equal(results[winner].value.nativeId, s.nativeId);
      a.close(); b.close(); peers.delete(a); peers.delete(b);
      await settle(s.id);
      const after = await output(s.id);
      assert.ok(after.nextCursor > before.nextCursor);
      if (provider !== 'codex') assert.ok(after.text.includes('ThreadTerm: session resumed at'));
      const retained = await peer.request('terminal.read', { sessionId: s.id, cursor: before.fromCursor, limit: Math.min(1048576, before.nextCursor - before.fromCursor) });
      assert.ok(Buffer.from(retained.data, 'base64').equals(Buffer.from(before.data, 'base64')), 'old output changed');
      const claim = await peer.request('session.claim', { sessionId: s.id, clientId: 'qa' });
      await peer.request('terminal.resize', { sessionId: s.id, cols: 100, rows: 30, leaseEpoch: claim.leaseEpoch });
      await peer.request('session.release', { sessionId: s.id, leaseEpoch: claim.leaseEpoch });
      if (live) await prompt(s, 'What was the secret word I asked you to remember? Reply with only that word. Do not use tools.', token);
      const replay = await peer.request('session.resume', { sessionId: s.id, operationId: winner === 0 ? opA : opB });
      assert.equal(replay.id, s.id);
      assert.equal((await snapshot()).sessions.filter(item => item.id === s.id).length, 1);
      note(`${provider}: ${kind} -> same identity, one resume winner, retained output, resize${live ? ', NEW answer recalls context' : ''}`);
    }
    await peer.request('session.stop', { sessionId: s.id, force: true, operationId: randomUUID() });
    await assert.rejects(peer.request('session.resume', { sessionId: s.id, cwd: join(scratch, 'missing-directory'), operationId: randomUUID() }), error => error.code === 'cwd_missing');
    assert.equal((await session(s.id)).nativeId, s.nativeId, 'failed resume discarded identity');
    const fresh = await peer.request('session.rerun', { sessionId: s.id, operationId: randomUUID() }, 90000);
    assert.notEqual(fresh.id, s.id); assert.notEqual(fresh.nativeId, s.nativeId);
    await peer.request('session.stop', { sessionId: fresh.id, force: true, operationId: randomUUID() });
    note(`${provider}: new-with-same-config uses a separate native identity`);
  }
  const shell = await peer.request('session.create', { cwd: scratch, provider: 'custom', mode: 'terminal', executable: 'cmd.exe', args: ['/C', 'echo SHELL_RERUN_OK'], operationId: randomUUID() });
  await waitFor(async () => (await session(shell.id)).status === 'exited', 'shell did not exit');
  await waitFor(async () => (await output(shell.id)).text.includes('SHELL_RERUN_OK'), 'shell output missing');
  const rerun = await peer.request('session.rerun', { sessionId: shell.id, operationId: randomUUID() });
  assert.notEqual(rerun.id, shell.id);
  await waitFor(async () => (await output(rerun.id)).text.includes('SHELL_RERUN_OK'), 'rerun output missing');
  note('shell/custom rerun remains a new execution with preserved old output');
  console.log(JSON.stringify({ passed: true, live, checks, scratch }));
} finally {
  for (const p of peers) p.close();
  if (daemon?.exitCode === null) daemon.kill();
  console.log(`QA artifacts: ${scratch}`);
}
