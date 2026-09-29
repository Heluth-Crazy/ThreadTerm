// Real Claude SDK/CLI absence boundary. Never submits a prompt or approves a
// native dialog; all runtime and Claude provider state stays in this Temp dir.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPeer } from './pipe-client.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exe = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target/debug/threadterm-v3-runtime.exe');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-claude-empty-resume-'));
const data = join(scratch, 'data');
const cwd = join(scratch, 'cwd');
const providerHome = join(scratch, 'claude-config');
const pipe = `\\\\.\\pipe\\threadterm-claude-empty-${randomUUID()}`;
await Promise.all([mkdir(data), mkdir(cwd), mkdir(providerHome)]);
let daemon;
let peer;
try {
  daemon = spawn(exe, [], {
    windowsHide: true,
    env: {
      ...process.env,
      THREADTERM_V3_DATA: data,
      THREADTERM_V3_USER_DATA: join(scratch, 'user-data'),
      THREADTERM_V3_PIPE: pipe,
      CLAUDE_CONFIG_DIR: providerHome,
      THREADTERM_CLAUDE_SETTING_SOURCES: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      peer = await connectPeer(`${pipe}-control`);
      await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      break;
    } catch {
      peer?.close();
      peer = undefined;
      if (daemon.exitCode !== null || daemon.signalCode !== null) throw Error('runtime exited at startup');
      await delay(100);
    }
  }
  assert.ok(peer, 'runtime startup timeout');
  const created = await peer.request('session.create', {
    cwd, title: 'Claude empty resume boundary', provider: 'claude', mode: 'terminal', operationId: randomUUID(),
  }, 90000);
  assert.ok(created.nativeId, 'Claude terminal must bind a native ID before launch');
  await peer.request('session.stop', { sessionId: created.id, force: true, operationId: randomUUID() });
  const before = (await peer.request('runtime.snapshot')).sessions.find(item => item.id === created.id);
  const bytes = await peer.request('terminal.read', { sessionId: created.id, cursor: 0, limit: 1048576 });
  await assert.rejects(
    peer.request('session.resume', { sessionId: created.id, operationId: randomUUID() }, 90000),
    error => error.code === 'session_has_no_native_history' && /Claude|conversation|history/i.test(error.message),
    'empty Claude history must be rejected before launching a transient PTY',
  );
  const after = (await peer.request('runtime.snapshot')).sessions.find(item => item.id === created.id);
  assert.equal(after.nativeId, created.nativeId);
  assert.equal(after.status, before.status);
  const remaining = await peer.request('terminal.read', { sessionId: created.id, cursor: 0, limit: 1048576 });
  assert.equal(remaining.nextCursor, bytes.nextCursor, 'preflight must not append a resume boundary');
  assert.equal(remaining.data, bytes.data, 'preflight must preserve original bytes');
  console.log(JSON.stringify({ passed: true, scratch, sessionId: created.id, nativeId: created.nativeId }));
} finally {
  peer?.close();
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
  console.log(`QA artifacts: ${scratch}`);
}
