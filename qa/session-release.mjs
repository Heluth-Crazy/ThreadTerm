// Runtime-level release QA: an isolated runtime, a fake Codex app-server, no real agent CLI.
// Verifies a chat and a terminal are released (process stopped, session kept) and resume the
// same native id, and that a released state survives a runtime restart.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connectSubagentPeer as connectPeer } from './lib/subagent-peer.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-session-release-'));
const bin = join(scratch, 'bin'), cwd = join(scratch, 'workspace'), data = join(scratch, 'data'), log = join(scratch, 'codex.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-session-release-${randomUUID()}`;
await Promise.all([mkdir(bin, { recursive: true }), mkdir(cwd, { recursive: true }), writeFile(log, '')]);
const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
await writeFile(join(bin, 'shim.rs'), shim);
const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true });
assert.equal(compiled.status, 0, compiled.stderr);
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? process.env.THREADTERM_V3_RUNTIME_BIN ?? 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), `Missing built runtime: ${runtime}`);
const runtimeCopy = join(scratch, 'runtime.exe');
await copyFile(runtime, runtimeCopy);
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_pipe'].includes(key.toLowerCase()))),
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe, CODEX_HOME: join(scratch, 'provider-home'),
  THREADTERM_QA_PROVIDER_BIN: bin, TT_QA_NODE: process.execPath,
  TT_QA_SCRIPT: resolve('qa/fixtures/fake-session-release-codex.cjs'),
  THREADTERM_QA_CODEX_COMPAT_LOG: log, THREADTERM_QA_CODEX_COMPAT_CWD: cwd,
};
assert.deepEqual(Object.keys(environment).filter(key => key.toLowerCase() === 'path'), ['Path']);
const pause = ms => new Promise(done => setTimeout(done, ms));
const report = { passed: false, scratch, runtime, checks: [] };
let daemon, peer;
async function start() {
  daemon = spawn(runtimeCopy, [], { env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  daemon.stderr.on('data', bytes => { diagnostic += bytes.toString(); });
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const next = await connectPeer(`${pipe}-control`);
      await next.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      peer = next;
      return;
    } catch {
      if (daemon.exitCode !== null) throw Error(diagnostic);
      await pause(50);
    }
  }
  throw Error('runtime startup timeout');
}
async function waitFor(read, accept, label) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await pause(50);
  }
  throw Error(`Timed out: ${label}`);
}
const snapshot = () => peer.request('runtime.snapshot');
const session = async id => (await snapshot()).sessions.find(row => row.id === id);
const release = id => peer.request('session.releaseResources', { sessionId: id, operationId: randomUUID() });
try {
  await start();
  const chat = await peer.request('session.create', { cwd, title: 'Release chat QA', provider: 'codex', mode: 'chat', operationId: randomUUID() });
  let { leaseEpoch } = await peer.request('session.claim', { sessionId: chat.id, clientId: 'qa' });
  assert.equal((await peer.request('chat.connect', { sessionId: chat.id, leaseEpoch, operationId: randomUUID() })).phase, 'ready');
  const chatNative = (await session(chat.id)).nativeId;
  const releasedChat = await release(chat.id);
  assert.equal(releasedChat.released, true);
  assert.equal(releasedChat.status, 'exited');
  assert.equal(releasedChat.nativeId, chatNative);
  assert.equal((await peer.request('chat.read', { sessionId: chat.id })).some(item => item.role === 'user'), false);
  ({ leaseEpoch } = await peer.request('session.claim', { sessionId: chat.id, clientId: 'qa' }));
  // An automatic reconnect (a mount, a visibility change, a disconnected phase)
  // carries no resume flag and is refused; only the explicit Continue resumes.
  await assert.rejects(
    peer.request('chat.connect', { sessionId: chat.id, leaseEpoch, operationId: randomUUID() }),
    error => String(error?.message ?? error).includes('session_resume_required'),
    'an automatic reconnect to a released chat is refused',
  );
  assert.equal((await session(chat.id)).released, true);
  assert.equal((await peer.request('chat.connect', { sessionId: chat.id, leaseEpoch, operationId: randomUUID(), resume: true })).phase, 'ready');
  assert.equal((await session(chat.id)).nativeId, chatNative);
  assert.equal((await peer.request('chat.read', { sessionId: chat.id })).some(item => item.role === 'user'), false);
  report.checks.push('an automatic connect to a released chat is refused; the explicit resume kept the native id and replayed no prompt');

  const terminal = await peer.request('session.create', { cwd, title: 'Release terminal QA', provider: 'codex', mode: 'terminal', operationId: randomUUID() });
  const terminalNative = terminal.nativeId;
  assert.ok(terminalNative, 'terminal native id is assigned before create returns');
  await waitFor(() => session(terminal.id), row => row?.status === 'running', 'terminal live');
  const releasedTerminal = await release(terminal.id);
  assert.equal(releasedTerminal.released, true);
  assert.equal(releasedTerminal.status, 'exited');
  assert.equal(releasedTerminal.nativeId, terminalNative);
  assert.equal((await snapshot()).sessions.find(row => row.id === terminal.id).released, true);
  const resumed = await peer.request('session.resume', { sessionId: terminal.id, operationId: randomUUID(), resume: true });
  assert.equal(resumed.nativeId, terminalNative);
  await waitFor(() => session(terminal.id), row => row?.status === 'running' && !row.released, 'terminal resumed');
  report.checks.push('terminal released, kept its session/native id, and resumed by the exact native id');

  // Bulk release (used by archive): checked under one lock, all or none.
  const blocked = await peer.request('session.create', { cwd, title: 'Archive blocked QA', provider: 'codex', mode: 'chat', operationId: randomUUID() });
  const blockedEpoch = (await peer.request('session.claim', { sessionId: blocked.id, clientId: 'qa' })).leaseEpoch;
  await peer.request('chat.connect', { sessionId: blocked.id, leaseEpoch: blockedEpoch, operationId: randomUUID() });
  await peer.request('chat.send', { sessionId: blocked.id, text: 'keep working', operationId: randomUUID(), leaseEpoch: blockedEpoch });
  await waitFor(() => session(blocked.id), row => row?.status === 'running', 'blocked chat running');
  const spare = await peer.request('session.create', { cwd, title: 'Archive spare QA', provider: 'codex', mode: 'chat', operationId: randomUUID() });
  const spareEpoch = (await peer.request('session.claim', { sessionId: spare.id, clientId: 'qa' })).leaseEpoch;
  await peer.request('chat.connect', { sessionId: spare.id, leaseEpoch: spareEpoch, operationId: randomUUID() });
  const refusedBulk = await peer.request('session.releaseResources.bulk', { sessionIds: [spare.id, blocked.id], operationId: randomUUID() });
  assert.equal(refusedBulk.released.length, 0, 'a refused bulk release stops nothing');
  assert.deepEqual(refusedBulk.refused.map(entry => entry.sessionId), [blocked.id]);
  assert.match(refusedBulk.refused[0].code, /session_release_blocked/);
  assert.ok(!(await session(spare.id)).released, 'a refusal stops nothing');
  const okBulk = await peer.request('session.releaseResources.bulk', { sessionIds: [spare.id], operationId: randomUUID() });
  assert.equal(okBulk.refused.length, 0);
  assert.equal(okBulk.released.length, 1);
  assert.equal(okBulk.released[0].released, true);
  report.checks.push('bulk release is all or none and names the session it cannot stop');

  // Persist the released marker across a runtime restart.
  await release(terminal.id);
  await peer.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  peer.close(); peer = undefined;
  for (let attempt = 0; attempt < 200 && daemon.exitCode === null; attempt++) await pause(50);
  await start();
  const restored = await session(terminal.id);
  assert.equal(restored.released, true);
  assert.equal(restored.status, 'exited');
  report.checks.push('released state survived a runtime restart');
  report.passed = true;
} catch (error) {  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (peer) { await peer.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {}); peer.close(); }
  if (daemon && daemon.exitCode === null) { await Promise.race([new Promise(done => daemon.once('exit', done)), pause(3000)]); if (daemon.exitCode === null) daemon.kill(); }
  console.log(JSON.stringify(report, null, 2));
}
