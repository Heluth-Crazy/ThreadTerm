// The desktop's check of the running local runtime (11-26): a maintenance connection that inspects a legacy
// (contract 20) or current runtime and stops it with the shutdown acknowledgement, the gate that holds ordinary
// connections until the check is done, and the dialog wording (runtimeReplacement.ts).
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PROTOCOL_CONTRACT, PROTOCOL_VERSION } from '@threadterm/protocol';
import {
  LEGACY_CONTRACT,
  RuntimeClient,
  checkedRuntimeExecutable,
  fileSha256,
  holdLocalRuntimeConnections,
  inspectLocalRuntime,
  openLocalRuntime,
} from '../src/runtime-client.js';
import { replacementOutcome, restartStillAsTold, runtimeReplacementChoice, runtimeReplacementPrompt, runtimeReplacementQaChoice, runtimeUnsettledPrompt } from '../src/runtimeReplacement.js';

const TOKEN = 'maintenance-test-token';

function sendJson(socket: net.Socket, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  socket.write(frame);
}
function readJson(socket: net.Socket, onValue: (value: Record<string, unknown>) => void): void {
  let incoming = Buffer.alloc(0);
  socket.on('data', chunk => {
    incoming = Buffer.concat([incoming, chunk]);
    while (incoming.length >= 4) {
      const length = incoming.readUInt32LE(0);
      if (incoming.length < 4 + length) return;
      onValue(JSON.parse(incoming.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>);
      incoming = incoming.subarray(4 + length);
    }
  });
}

type Seen = { auths: Record<string, unknown>[]; methods: string[]; acknowledged: string[]; connections: number };
/** A runtime on a private pipe that speaks `contract`, as the real transport does (runtime/src/transport.rs). */
type Snapshot = 'normal' | 'malformed' | 'drop';
async function fakeRuntime(contract: number, build?: { sha256: string; path: string }, snapshot: () => Snapshot = () => 'normal') {
  const data = await mkdtemp(join(tmpdir(), 'tt-maintenance-'));
  const base = `\\\\.\\pipe\\tt-maintenance-${process.pid}-${randomUUID()}`;
  await writeFile(join(data, 'runtime.credential'), TOKEN);
  const seen: Seen = { auths: [], methods: [], acknowledged: [], connections: 0 };
  const server = net.createServer(socket => {
    seen.connections += 1;
    const nonce = randomUUID();
    sendJson(socket, { kind: 'challenge', nonce, protocol: PROTOCOL_VERSION, contract });
    let shutdownId: string | undefined;
    readJson(socket, value => {
      if (value.kind === 'auth') {
        seen.auths.push(value);
        if (value.contract !== contract) { sendJson(socket, { kind: 'incompatible', code: 'protocol_incompatible', message: 'contract', protocol: PROTOCOL_VERSION, contract }); socket.end(); return; }
        const expected = createHmac('sha256', TOKEN).update(`${PROTOCOL_VERSION}:${String(value.clientId)}:${nonce}`).digest('hex');
        assert.equal(value.hmac, expected, 'the client proves the credential');
        const proof = createHmac('sha256', TOKEN).update(`server:${PROTOCOL_VERSION}:${String(value.clientId)}:${nonce}`).digest('hex');
        sendJson(socket, { kind: 'authenticated', principal: value.clientId, epoch: 'epoch', contract, hmac: proof, ...(build ? { build } : {}) });
        return;
      }
      if (value.kind === 'shutdownAck') { seen.acknowledged.push(String(value.id)); if (value.id === shutdownId) { socket.end(); server.close(); } return; }
      const method = String(value.method);
      seen.methods.push(method);
      // An event first: a maintenance connection must skip it.
      sendJson(socket, { v: 1, event: 'state.changed', epoch: 'epoch', seq: 1, data: { kind: 'settings' } });
      const answer = method === 'runtime.snapshot' ? snapshot() : 'normal';
      if (answer === 'drop') { socket.destroy(); return; }
      if (method === 'runtime.snapshot' && answer === 'malformed') sendJson(socket, { v: 1, id: value.id, result: { sessions: [{ status: 'running' }, { title: 'no status' }], settings: {} } });
      else if (method === 'runtime.snapshot') sendJson(socket, { v: 1, id: value.id, result: { sessions: [{ status: 'running' }, { status: 'exited' }, { status: 'idle' }], settings: { language: 'zh-CN', remoteMachines: { enabled: true } } } });
      else if (method === 'runtime.health') sendJson(socket, { v: 1, id: value.id, result: { version: 'test', epoch: 'epoch', contract } });
      else if (method === 'runtime.shutdown') { shutdownId = String(value.id); sendJson(socket, { v: 1, id: value.id, result: null }); }
      else sendJson(socket, { v: 1, id: value.id, error: { code: 'unexpected', message: method } });
    });
  });
  await new Promise<void>(resolvePromise => server.listen(`${base}-control`, resolvePromise));
  const previous = { pipe: process.env.THREADTERM_V3_PIPE, data: process.env.THREADTERM_V3_DATA };
  process.env.THREADTERM_V3_PIPE = base;
  process.env.THREADTERM_V3_DATA = data;
  return {
    seen,
    server,
    async close() {
      if (server.listening) await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
      if (previous.pipe === undefined) delete process.env.THREADTERM_V3_PIPE; else process.env.THREADTERM_V3_PIPE = previous.pipe;
      if (previous.data === undefined) delete process.env.THREADTERM_V3_DATA; else process.env.THREADTERM_V3_DATA = previous.data;
      await rm(data, { recursive: true, force: true });
    },
  };
}

test('a legacy runtime is inspected with its own contract and its live sessions are counted', async () => {
  const runtime = await fakeRuntime(LEGACY_CONTRACT);
  try {
    const state = await inspectLocalRuntime();
    assert.ok(state && state !== 'incompatible');
    assert.deepEqual({ contract: state.contract, build: state.build, liveSessions: state.liveSessions, remoteAccess: state.remoteAccess }, { contract: 20, build: undefined, liveSessions: 2, remoteAccess: true });
    assert.equal(runtime.seen.auths[0]?.contract, LEGACY_CONTRACT);
    assert.deepEqual(runtime.seen.methods, ['runtime.snapshot'], 'nothing but the snapshot');
  } finally { await runtime.close(); }
});

test('a current runtime reports its build, another contract is not even authenticated', async () => {
  const build = { sha256: 'a'.repeat(64), path: 'C:\\ThreadTerm\\resources\\runtime\\threadterm-v3-runtime.exe' };
  const current = await fakeRuntime(PROTOCOL_CONTRACT, build);
  try {
    const state = await inspectLocalRuntime();
    assert.ok(state && state !== 'incompatible');
    assert.equal(state.contract, PROTOCOL_CONTRACT);
    assert.deepEqual(state.build, build);
  } finally { await current.close(); }
  const other = await fakeRuntime(7);
  try {
    assert.equal(await inspectLocalRuntime(), 'incompatible');
    assert.equal(other.seen.auths.length, 0, 'no credential proof for a contract it cannot use');
  } finally { await other.close(); }
});

test('no runtime running: nothing to inspect or open', async () => {
  const runtime = await fakeRuntime(LEGACY_CONTRACT);
  await new Promise<void>(resolvePromise => runtime.server.close(() => resolvePromise()));
  try {
    assert.equal(await inspectLocalRuntime(), undefined);
    assert.equal(await openLocalRuntime(), undefined);
  } finally { await runtime.close(); }
});

test('one connection reads the runtime twice and stops that runtime with the acknowledgement', async () => {
  const runtime = await fakeRuntime(LEGACY_CONTRACT);
  try {
    const handle = await openLocalRuntime();
    assert.ok(handle && handle !== 'incompatible');
    const told = await handle.state();
    const now = await handle.state();
    assert.equal(runtime.seen.connections, 1, 'the stop goes to the runtime that was shown');
    assert.ok(restartStillAsTold(told, now));
    await handle.stop();
    handle.close();
    assert.deepEqual(runtime.seen.methods, ['runtime.snapshot', 'runtime.snapshot', 'runtime.shutdown']);
    assert.equal(runtime.seen.acknowledged.length, 1, 'the shutdown reply is acknowledged');
    assert.equal(runtime.server.listening, false);
  } finally { await runtime.close(); }
});

test('an unreadable session list stays unknown, and a dropped connection rejects the pending read', async () => {
  const malformed = await fakeRuntime(LEGACY_CONTRACT, undefined, () => 'malformed');
  try {
    const state = await inspectLocalRuntime();
    assert.ok(state && state !== 'incompatible');
    assert.equal(state.liveSessions, undefined, 'not "no sessions"');
    assert.match(runtimeReplacementPrompt({ legacy: true, liveSessions: state.liveSessions, remoteAccess: false, zh: true }).detail, /读不到它正在运行哪些会话/);
  } finally { await malformed.close(); }
  let reads = 0;
  const dropping = await fakeRuntime(LEGACY_CONTRACT, undefined, () => (reads += 1) === 1 ? 'normal' : 'drop');
  try {
    const handle = await openLocalRuntime();
    assert.ok(handle && handle !== 'incompatible');
    await handle.state();
    // The dialog was open while the connection went away: the second read fails, nothing is stopped.
    await assert.rejects(handle.state());
    handle.close();
    assert.deepEqual(dropping.seen.methods, ['runtime.snapshot', 'runtime.snapshot']);
  } finally { await dropping.close(); }
});

test('a local client that met the old contract connects again once the runtime was replaced', async () => {
  const legacy = await fakeRuntime(LEGACY_CONTRACT);
  const client = new RuntimeClient({ controlOnly: true, autoLaunch: false });
  const transport: string[] = [];
  client.onEvent(event => { if (event.event === 'runtime.transport') transport.push(String((event.data as { state?: unknown }).state)); });
  try {
    await assert.rejects(client.request('runtime.health', {}), /contract/);
    assert.ok(transport.includes('incompatible'));
  } finally { await legacy.close(); }
  const current = await fakeRuntime(PROTOCOL_CONTRACT);
  try {
    client.retryAfterRuntimeReplaced();
    assert.equal((await client.request('runtime.health', {})).contract, PROTOCOL_CONTRACT);
    assert.ok(transport.includes('reconnected'), 'views hear that the runtime is back');
  } finally {
    client.dispose();
    await current.close();
  }
});

test('ordinary local connections wait for the runtime check', async () => {
  const runtime = await fakeRuntime(PROTOCOL_CONTRACT);
  let release!: () => void;
  holdLocalRuntimeConnections(new Promise<void>(resolvePromise => { release = resolvePromise; }));
  const client = new RuntimeClient({ controlOnly: true, autoLaunch: false });
  try {
    const health = client.request('runtime.health', {});
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
    assert.equal(runtime.seen.connections, 0, 'no connection while the check runs');
    release();
    assert.equal((await health).contract, PROTOCOL_CONTRACT);
    assert.equal(runtime.seen.connections, 1);
  } finally {
    holdLocalRuntimeConnections(Promise.resolve());
    client.dispose();
    await runtime.close();
  }
});

test('the check applies to packaged desktops and to QA runs that opt in; the digest is the file\'s', async () => {
  assert.equal(checkedRuntimeExecutable(true, {}, 'C:\\app\\resources'), join('C:\\app\\resources', 'runtime', 'threadterm-v3-runtime.exe'));
  assert.equal(checkedRuntimeExecutable(true, { THREADTERM_V3_RUNTIME: 'C:\\other.exe' }, 'C:\\app\\resources'), undefined);
  assert.equal(checkedRuntimeExecutable(false, { THREADTERM_V3_RUNTIME: 'C:\\qa.exe' }, 'C:\\app\\resources'), undefined);
  assert.equal(checkedRuntimeExecutable(false, { THREADTERM_V3_RUNTIME: 'C:\\qa.exe', THREADTERM_QA_RUNTIME_IDENTITY: '1' }, 'C:\\app\\resources'), 'C:\\qa.exe');
  const dir = await mkdtemp(join(tmpdir(), 'tt-digest-'));
  try {
    const bytes = Buffer.alloc(300_000, 7);
    await writeFile(join(dir, 'runtime.exe'), bytes);
    assert.equal(await fileSha256(join(dir, 'runtime.exe')), createHash('sha256').update(bytes).digest('hex'));
    assert.equal(await fileSha256(join(dir, 'missing.exe')), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the dialog says what a restart ends, and a legacy runtime offers no way to keep it', () => {
  const legacy = runtimeReplacementPrompt({ legacy: true, liveSessions: 2, remoteAccess: true, zh: true });
  assert.deepEqual(legacy.buttons, ['重启后台程序', '退出']);
  assert.match(legacy.detail, /结束它正在运行的所有会话（现在 2 个）/, 'a restart ends whatever runs then, not just the sessions counted');
  assert.match(legacy.detail, /配对的电脑会暂时断开/);
  const other = runtimeReplacementPrompt({ legacy: false, liveSessions: 0, remoteAccess: false, runtimePath: 'D:\\old\\threadterm-v3-runtime.exe', zh: false });
  assert.deepEqual(other.buttons, ['Restart background program', 'Not this time']);
  assert.match(other.detail, /D:\\old\\threadterm-v3-runtime\.exe/);
  assert.match(other.detail, /No session is running/);
  assert.equal(runtimeReplacementChoice(0, true), 'restart');
  assert.equal(runtimeReplacementChoice(1, true), 'quit');
  assert.equal(runtimeReplacementChoice(1, false), 'keep');
  assert.equal(runtimeReplacementQaChoice(true, { THREADTERM_QA_RUNTIME_REPLACE: 'restart' }), undefined, 'never in a packaged app');
  assert.equal(runtimeReplacementQaChoice(false, { THREADTERM_QA_RUNTIME_REPLACE: 'keep' }), 'keep');
  // What a restart ends, read again just before it: more sessions, newly served computers or an unreadable list ask again.
  assert.equal(restartStillAsTold({ liveSessions: 2, remoteAccess: false }, { liveSessions: 1, remoteAccess: false }), true);
  assert.equal(restartStillAsTold({ liveSessions: 2, remoteAccess: false }, { liveSessions: 3, remoteAccess: false }), false);
  assert.equal(restartStillAsTold({ liveSessions: 0, remoteAccess: false }, { liveSessions: 0, remoteAccess: true }), false);
  assert.equal(restartStillAsTold({ liveSessions: 0, remoteAccess: false }, { liveSessions: undefined, remoteAccess: false }), false);
  assert.equal(restartStillAsTold({ liveSessions: undefined, remoteAccess: false }, { liveSessions: 4, remoteAccess: false }), true);
  // After a restart: a legacy runtime back, or a compatible one of another known build.
  const own = 'b'.repeat(64);
  assert.equal(replacementOutcome({ contract: 20 }, 21, own), 'legacy');
  assert.equal(replacementOutcome({ contract: 21, build: { sha256: 'c'.repeat(64) } }, 21, own), 'other-build');
  assert.equal(replacementOutcome({ contract: 21, build: { sha256: own } }, 21, own), 'ok');
  assert.equal(replacementOutcome({ contract: 21 }, 21, own), 'ok', 'an unknown digest is not a difference');
  assert.equal(replacementOutcome(undefined, 21, own), 'ok');
  // Rounds ran out: a legacy runtime leaves only quitting; another build can be kept.
  assert.deepEqual(runtimeUnsettledPrompt(true, true).buttons, ['退出']);
  assert.deepEqual(runtimeUnsettledPrompt(false, false).buttons, ['Keep working', 'Quit']);
});
