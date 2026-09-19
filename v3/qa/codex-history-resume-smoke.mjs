import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { connectPeer } from './pipe-client.mjs';

const requested = process.argv[2];
const requestedNativeId = requested === '--new' ? undefined : requested;
if (!requestedNativeId && requested !== '--new') throw new Error('usage: node qa/codex-history-resume-smoke.mjs <existing-native-id>|--new');
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const root = await mkdtemp(join(tmpdir(), 'threadterm-v3-codex-history-'));
const cwd = process.env.THREADTERM_V3_CWD ?? join(root, 'workspace');
const pipe = `\\\\.\\pipe\\threadterm-v3-codex-history-${randomUUID()}`;
await mkdir(cwd, { recursive: true });
const daemon = spawn(process.env.THREADTERM_V3_RUNTIME_BIN ?? resolve('runtime/target/debug/threadterm-v3-runtime.exe'), [], {
  env: { ...process.env, THREADTERM_V3_DATA: join(root, 'data'), THREADTERM_V3_PIPE: pipe },
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let diagnostic = '';
daemon.stderr.on('data', (bytes) => { diagnostic += bytes; });
let peer;
let clientId;
try {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      peer = await connectPeer(`${pipe}-control`);
      const credential = (await readFile(join(root, 'data/runtime.credential'), 'utf8')).trim();
      clientId = await peer.auth(credential);
      break;
    } catch (error) {
      peer?.close(); peer = undefined;
      if (daemon.exitCode !== null) throw error;
      await delay(100);
    }
  }
  if (!peer) throw new Error('runtime startup timeout');
  const created = await peer.request('session.create', {
    cwd,
    provider: 'codex',
    mode: 'chat',
    ...(requestedNativeId ? { nativeId: requestedNativeId } : {}),
    operationId: randomUUID(),
  }, 45_000);
  const leaseEpoch = (await peer.request('session.claim', {
    sessionId: created.id,
    clientId,
  })).leaseEpoch;
  const connection = await peer.request('chat.connect', {
    sessionId: created.id,
    leaseEpoch,
    operationId: randomUUID(),
  }, 45_000);
  const nativeId = connection.nativeId ?? created.nativeId;
  if (typeof nativeId !== 'string') throw new Error('created Codex session has no native id');
  if (!requestedNativeId) {
    await peer.request('chat.send', {
      sessionId: created.id,
      text: 'Reply OK only.',
      operationId: randomUUID(),
      leaseEpoch,
    }, 45_000);
    const completionDeadline = Date.now() + 120_000;
    while (Date.now() < completionDeadline) {
      const snapshot = await peer.request('runtime.snapshot');
      const session = snapshot.sessions.find((item) => item.id === created.id);
      const transcript = await peer.request('chat.read', { sessionId: created.id });
      if (session?.status === 'error') throw new Error('Codex turn entered error state');
      if (session?.status === 'idle' && transcript.some((item) => item.role === 'assistant')) break;
      await delay(250);
    }
  }
  const historyDeadline = Date.now() + 30_000;
  let history;
  do {
    history = await peer.request('history.list', { provider: 'codex', cwd, limit: 100 }, 45_000);
    if (history.items.some((item) => item.nativeId === nativeId)) break;
    await delay(250);
  } while (Date.now() < historyDeadline);
  const listed = history.items.some((item) => item.nativeId === nativeId);
  if (!listed) throw new Error('new Codex thread was not discoverable through history.list');
  const transcript = await peer.request('history.read', { provider: 'codex', nativeId }, 45_000);
  await peer.request('session.stop', { sessionId: created.id, operationId: randomUUID() }, 45_000);
  const operationId = randomUUID();
  const resumed = await peer.request('session.resume', { sessionId: created.id, cwd, operationId }, 45_000);
  const replay = await peer.request('session.resume', { sessionId: created.id, cwd, operationId }, 45_000);
  if (resumed.id !== created.id || resumed.nativeId !== nativeId || replay.id !== created.id || replay.nativeId !== nativeId) throw new Error('same-id resume was not idempotent');
  console.log(JSON.stringify({ listed, transcriptItems: transcript.length, sameSessionId: true, idempotentResume: true }));
  await peer.request('session.stop', { sessionId: created.id, operationId: randomUUID() }, 45_000);
  await peer.request('runtime.shutdown', { operationId: randomUUID() }, 45_000);
} catch (error) {
  error.message += diagnostic ? `\nruntime stderr:\n${diagnostic}` : '';
  throw error;
} finally {
  peer?.close();
  if (daemon.exitCode === null) daemon.kill();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
