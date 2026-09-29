// Issue 9 (package B) end-to-end: real runtime + real bundled Claude SDK host.
// The control handshake completes with NO prompt and NO model message.
// The credential gate only checks env presence; ANTHROPIC_API_KEY here is a
// placeholder and the SDK initialization is local control traffic.
//   node qa/claude-chat-handshake.mjs
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
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-claude-chat-'));
const data = join(scratch, 'data');
const pipe = `\\\\.\\pipe\\threadterm-claude-chat-${randomUUID()}`;
const checks = [];
const note = text => { checks.push(text); console.log(`PASS ${text}`); };
let daemon;
const peers = new Set();

async function start(extraEnv = {}) {
  await mkdir(data, { recursive: true });
  daemon = spawn(exe, [], {
    windowsHide: true,
    env: {
      ...process.env, ...extraEnv,
      ANTHROPIC_API_KEY: 'qa-handshake-placeholder',
      CLAUDE_CONFIG_DIR: join(scratch, 'claude-config'),
      THREADTERM_CLAUDE_SETTING_SOURCES: '',
      THREADTERM_V3_DATA: data,
      THREADTERM_V3_USER_DATA: join(scratch, 'user-data'),
      THREADTERM_V3_PIPE: pipe,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    try {
      const p = await connectPeer(`${pipe}-control`);
      await p.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      const request = p.request.bind(p);
      p.request = (method, params = {}, timeoutMs = 90000) => request(method, params, timeoutMs);
      peers.add(p);
      return p;
    } catch { if (daemon.exitCode !== null) throw Error('daemon exited at startup'); await delay(100); }
  }
  throw Error('runtime startup timeout');
}
async function stopDaemon() {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
  for (const p of peers) p.close();
  peers.clear();
  await delay(300);
}

try {
  // 1. Real handshake: connect must not report ready before the SDK control
  //    initialization actually completed inside the sidecar.
  let peer = await start();
  const s = await peer.request('session.create', { cwd: scratch, title: 'QA claude chat handshake', provider: 'claude', mode: 'chat', operationId: randomUUID() });
  assert.equal(s.status, 'starting', 'chat creation returns starting before the handshake');
  const { leaseEpoch } = await peer.request('session.claim', { sessionId: s.id, clientId: 'qa-claude-chat' });
  const began = Date.now();
  const connection = await peer.request('chat.connect', { sessionId: s.id, leaseEpoch, operationId: randomUUID() });
  note(`chat.connect returned phase=${connection.phase} after ${Date.now() - began}ms`);
  assert.equal(connection.phase, 'ready', 'connect must resolve ready only after the handshake');
  const record = (await peer.request('runtime.snapshot')).sessions.find(x => x.id === s.id);
  assert.ok(['idle', 'running', 'waiting'].includes(record.status), `unexpected session status ${record.status}`);
  note('real SDK control handshake completed without any prompt or model message');

  // 2. Controlled failure: a bogus CLI must fail the connect with a visible
  //    error, never a fake ready.
  await stopDaemon();
  peer = await start({ THREADTERM_CLAUDE_PATH: join(scratch, 'no-such-claude.exe') });
  const broken = await peer.request('session.create', { cwd: scratch, title: 'QA claude chat failure', provider: 'claude', mode: 'chat', operationId: randomUUID() });
  const claim = await peer.request('session.claim', { sessionId: broken.id, clientId: 'qa-claude-chat' });
  const failed = await peer.request('chat.connect', { sessionId: broken.id, leaseEpoch: claim.leaseEpoch, operationId: randomUUID() }).then(
    value => ({ unexpected: value }),
    error => ({ error }),
  );
  assert.ok(failed.error, 'a broken CLI must fail the connect');
  const state = await peer.request('chat.connection', { sessionId: broken.id });
  assert.equal(state.phase, 'failed', `broken connect must end failed, got ${state.phase}`);
  assert.ok(state.error?.message?.length > 0, 'failure must carry a visible message');
  assert.ok(state.error.retryable !== undefined, 'failure carries retry semantics');
  note(`controlled failure visible: ${state.error.code ?? failed.error.code ?? 'error'} (${String(state.error.message).slice(0, 80)})`);
  await peer.request('session.release', { sessionId: broken.id, leaseEpoch: claim.leaseEpoch }).catch(() => {});

  // 3. Retry with the healthy configuration replaces the failed generation.
  await stopDaemon();
  peer = await start();
  const reclaim = await peer.request('session.claim', { sessionId: broken.id, clientId: 'qa-claude-chat' });
  const retry = await peer.request('chat.connect', { sessionId: broken.id, leaseEpoch: reclaim.leaseEpoch, operationId: randomUUID() });
  assert.equal(retry.phase, 'ready', 'retry with a healthy worker must recover the same session');
  assert.equal(retry.sessionId, broken.id, 'retry keeps the ThreadTerm session identity');
  note('explicit retry after a controlled failure recovered the same session');

  console.log(JSON.stringify({ passed: true, checks, scratch }));
} finally {
  await stopDaemon();
  console.log(`QA artifacts: ${scratch}`);
}
