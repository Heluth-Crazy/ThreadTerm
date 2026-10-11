import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PROTOCOL_CONTRACT, PROTOCOL_VERSION } from '@threadterm/protocol';
import {
  parseAuthChallenge,
  ProtocolIncompatibleError,
  RuntimeClient,
  RuntimeUnavailableError,
  waitForPendingRuntimeStartup,
} from '../src/runtime-client.js';

type ClientInternals = {
  control?: { write(payload: Buffer): void; close(): void };
  output?: { write(payload: Buffer): void; close(): void };
  outputGroups: Map<string, { cursor: number }>;
  request: RuntimeClient['request'];
  handleOutputFrame(frame: Buffer, origin?: { write(payload: Buffer): void; close(): void }): Promise<void>;
};

type StartupInternals = {
  connectAndAuthenticate(): Promise<void>;
  control?: { write(payload: Buffer): void; close(): void };
  output?: { write(payload: Buffer): void; close(): void };
  attachControl(connection: {
    write(payload: Buffer): void;
    close(): void;
    onFrame(listener: (frame: Buffer) => void): () => void;
    onFailure(listener: (error: Error) => void): () => void;
  }): Promise<never>;
};

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
      const frame = incoming.subarray(4, 4 + length);
      incoming = incoming.subarray(4 + length);
      onValue(JSON.parse(frame.toString('utf8')) as Record<string, unknown>);
    }
  });
}

function listen(server: net.Server, pipe: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => { server.off('error', reject); resolve(); });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test('concurrent first connection failures recover the connection once without replaying failed requests', async () => {
  const client = new RuntimeClient();
  const internal = client as unknown as StartupInternals;
  let attempts = 0;
  let writes = 0;
  let recovered!: () => void;
  const recovery = new Promise<void>(resolve => { recovered = resolve; });
  internal.connectAndAuthenticate = async () => {
    if (++attempts === 1) throw new RuntimeUnavailableError('startup pipe is not ready');
    internal.control = {write() { writes++; },close() {}};
    internal.output = {write() {},close() {}};
    recovered();
  };
  try {
    const results = await Promise.allSettled([client.request('runtime.health', {}), client.request('runtime.snapshot', {})]);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.equal(attempts, 1, 'initial callers share one connection attempt');
    await recovery;
    assert.equal(attempts, 2, 'one ordinary reconnect follows the initial failure');
    assert.equal(writes, 0, 'connection recovery never replays the failed RPCs');
  } finally { client.dispose(); }
});

for (const operation of ['dispose', 'suspend'] as const) {
  test(`${operation} cancels recovery scheduled by an initial connection failure`, async () => {
    const client = new RuntimeClient();
    const internal = client as unknown as StartupInternals;
    let attempts = 0;
    internal.connectAndAuthenticate = async () => { attempts++; throw new RuntimeUnavailableError('startup pipe is not ready'); };
    try {
      await assert.rejects(client.request('runtime.health', {}), /startup pipe/);
      if (operation === 'dispose') client.dispose(); else client.setSuspended(true);
      await new Promise(resolve => setTimeout(resolve, 450));
      assert.equal(attempts, 1, 'shutdown must not launch a new connection attempt');
    } finally { client.dispose(); }
  });
}

test('a wire-mismatched challenge is parsed as incompatible and is not retried as a transient startup failure', async () => {
  const client = new RuntimeClient();
  const internal = client as unknown as StartupInternals;
  const transportStates: string[] = [];
  const unsubscribe = client.onEvent(event => {
    if (event.event === 'runtime.transport') transportStates.push(String((event.data as {state?: unknown}).state));
  });
  let attempts = 0;
  internal.connectAndAuthenticate = async () => {
    attempts++;
    parseAuthChallenge({ kind: 'challenge', nonce: 'n', protocol: PROTOCOL_VERSION + 1, contract: PROTOCOL_CONTRACT });
  };
  try {
    await assert.rejects(client.request('runtime.health', {}), (error: unknown) => (
      error instanceof ProtocolIncompatibleError && /wire protocol/.test(error.message)
    ));
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(attempts, 1);
    assert.deepEqual(transportStates, ['incompatible']);
  } finally {
    unsubscribe();
    client.dispose();
  }
});

test('each failed startup or reconnect attempt emits one disconnected event', async () => {
  const client = new RuntimeClient();
  const internal = client as unknown as StartupInternals;
  const disconnectReasons: string[] = [];
  const unsubscribe = client.onEvent(event => {
    if (event.event === 'runtime.transport' && (event.data as {state?: unknown}).state === 'disconnected') {
      disconnectReasons.push(String((event.data as {reason?: unknown}).reason));
    }
  });
  let attempts = 0;
  let secondAttemptStarted!: () => void;
  const secondAttempt = new Promise<void>(resolve => { secondAttemptStarted = resolve; });
  internal.connectAndAuthenticate = async () => {
    attempts++;
    if (attempts === 2) {
      client.setSuspended(true);
      secondAttemptStarted();
    }
    throw new RuntimeUnavailableError(`connection failure ${attempts}`);
  };
  try {
    await assert.rejects(client.request('runtime.health', {}), /connection failure 1/);
    await secondAttempt;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 2);
    assert.deepEqual(disconnectReasons, ['connection failure 1', 'connection failure 2']);
  } finally {
    unsubscribe();
    client.dispose();
  }
});

test('shutdown quiescence waits for only the current connection attempt and consumes its failure', async () => {
  const client = new RuntimeClient();
  const internal = client as unknown as StartupInternals;
  let attempts = 0;
  let rejectAttempt!: (error: Error) => void;
  internal.connectAndAuthenticate = () => {
    attempts++;
    return new Promise<void>((_, reject) => { rejectAttempt = reject; });
  };
  const request = client.request('runtime.health', {});
  client.setSuspended(true);
  let settled = false;
  const quiesced = client.whenConnectionAttemptSettled().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  rejectAttempt(new RuntimeUnavailableError('connection attempt stopped'));
  await quiesced;
  await assert.rejects(request, /connection attempt stopped/);
  await client.whenConnectionAttemptSettled();
  assert.equal(attempts, 1, 'quiescence never starts or retries a connection');
  client.dispose();
});

for (const operation of ['dispose', 'suspend'] as const) {
  test(`${operation} during launcher setup prevents runtime spawn side effects`, async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'threadterm-runtime-launch-'));
    const previousPipe = process.env.THREADTERM_V3_PIPE;
    const previousData = process.env.THREADTERM_V3_DATA;
    const previousRuntime = process.env.THREADTERM_V3_RUNTIME;
    process.env.THREADTERM_V3_PIPE = `\\\\.\\pipe\\threadterm-runtime-launch-${process.pid}-${randomUUID()}`;
    process.env.THREADTERM_V3_DATA = dataDirectory;
    process.env.THREADTERM_V3_RUNTIME = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
    const client = new RuntimeClient();
    try {
      const request = client.request('runtime.health', {});
      queueMicrotask(() => { if (operation === 'dispose') client.dispose(); else client.setSuspended(true); });
      await assert.rejects(request, operation === 'dispose' ? /Desktop is closing/ : /shutdown is in progress/);
      await assert.rejects(access(join(dataDirectory, 'runtime.log')), (error: unknown) => (
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ));
    } finally {
      client.dispose();
      await rm(dataDirectory, { recursive: true, force: true });
      if (previousPipe === undefined) delete process.env.THREADTERM_V3_PIPE; else process.env.THREADTERM_V3_PIPE = previousPipe;
      if (previousData === undefined) delete process.env.THREADTERM_V3_DATA; else process.env.THREADTERM_V3_DATA = previousData;
      if (previousRuntime === undefined) delete process.env.THREADTERM_V3_RUNTIME; else process.env.THREADTERM_V3_RUNTIME = previousRuntime;
    }
  });
}

test('shutdown waits for every owned startup until a surviving child binds the control pipe', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'threadterm-runtime-pending-'));
  const pipeBase = `\\\\.\\pipe\\threadterm-runtime-pending-${process.pid}-${randomUUID()}`;
  const bootstrapPath = join(dataDirectory, 'bootstrap.cjs');
  const loserStartedPath = join(dataDirectory, 'loser-started');
  const firstConnectedPath = join(dataDirectory, 'first-connected');
  const childDonePath = join(dataDirectory, 'child-done');
  const previousPipe = process.env.THREADTERM_V3_PIPE;
  const previousData = process.env.THREADTERM_V3_DATA;
  const previousRuntime = process.env.THREADTERM_V3_RUNTIME;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  await writeFile(bootstrapPath, String.raw`
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const data = process.env.THREADTERM_V3_DATA;
const pipe = process.env.THREADTERM_V3_PIPE + '-control';
setTimeout(() => process.exit(5), 5_000);
let winner = false;
try {
  const lock = fs.openSync(path.join(data, 'startup-owner'), 'wx');
  fs.closeSync(lock);
  winner = true;
} catch {}
if (!winner) {
  fs.writeFileSync(path.join(data, 'loser-started'), '1');
  setTimeout(() => process.exit(0), 100);
} else {
  fs.writeFileSync(path.join(data, 'runtime.credential'), 'test-credential');
  const sockets = new Set();
  let closing = false;
  const first = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (closing) return;
    closing = true;
    fs.writeFileSync(path.join(data, 'first-connected'), '1');
    setTimeout(() => {
      for (const active of sockets) active.destroy();
      first.close(() => setTimeout(() => {
        const ready = net.createServer(socket => socket.destroy());
        ready.listen(pipe, () => setTimeout(() => ready.close(() => {
          fs.writeFileSync(path.join(data, 'child-done'), '1');
          process.exit(0);
        }), 1_000));
      }, 700));
    }, 75);
  });
  first.listen(pipe);
}
`);
  process.env.THREADTERM_V3_PIPE = pipeBase;
  process.env.THREADTERM_V3_DATA = dataDirectory;
  process.env.THREADTERM_V3_RUNTIME = process.execPath;
  process.env.NODE_OPTIONS = `${previousNodeOptions ? `${previousNodeOptions} ` : ''}--require=${bootstrapPath.replace(/\\/g, '/')}`;

  const first = new RuntimeClient();
  const second = new RuntimeClient();
  const requests = [first.request('runtime.health', {}), second.request('runtime.health', {})];
  try {
    await Promise.all([waitForFile(loserStartedPath), waitForFile(firstConnectedPath)]);
    first.setSuspended(true);
    second.setSuspended(true);
    first.dispose();
    second.dispose();
    const results = await Promise.allSettled(requests);
    assert.ok(results.every(result => result.status === 'rejected'));

    await assert.rejects(
      waitForPendingRuntimeStartup(100),
      /Timed out waiting for the launched runtime/,
      'one singleton loser exiting must not hide the surviving owned startup',
    );
    const started = Date.now();
    await waitForPendingRuntimeStartup(3_000);
    assert.ok(Date.now() - started >= 300, 'the passive wait must remain pending until the late control bind');
    await waitForPendingRuntimeStartup(0);
    await waitForFile(childDonePath, 3_000);
  } finally {
    first.dispose();
    second.dispose();
    try { await waitForFile(childDonePath, 5_500); } catch {}
    await rm(dataDirectory, { recursive: true, force: true });
    if (previousPipe === undefined) delete process.env.THREADTERM_V3_PIPE; else process.env.THREADTERM_V3_PIPE = previousPipe;
    if (previousData === undefined) delete process.env.THREADTERM_V3_DATA; else process.env.THREADTERM_V3_DATA = previousData;
    if (previousRuntime === undefined) delete process.env.THREADTERM_V3_RUNTIME; else process.env.THREADTERM_V3_RUNTIME = previousRuntime;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousNodeOptions;
  }
});

test('a control failure aborts an in-flight output handshake instead of producing a half-ready client', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'threadterm-runtime-client-'));
  const credential = 'test-credential';
  await writeFile(join(dataDirectory, 'runtime.credential'), credential, 'utf8');
  const pipeBase = `\\\\.\\pipe\\threadterm-runtime-client-${process.pid}-${randomUUID()}`;
  const controlServer = net.createServer();
  const outputServer = net.createServer();
  const sockets = new Set<net.Socket>();
  const previousPipe = process.env.THREADTERM_V3_PIPE;
  const previousData = process.env.THREADTERM_V3_DATA;
  process.env.THREADTERM_V3_PIPE = pipeBase;
  process.env.THREADTERM_V3_DATA = dataDirectory;

  let controlSocket: net.Socket | undefined;
  let outputAuthenticated!: () => void;
  const outputAuthReceived = new Promise<void>(resolve => { outputAuthenticated = resolve; });
  let disconnected!: () => void;
  const controlDisconnected = new Promise<void>(resolve => { disconnected = resolve; });
  const receivedMethods: unknown[] = [];
  const nonce = 'partial-handshake-nonce';

  controlServer.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    controlSocket = socket;
    sendJson(socket, { kind: 'challenge', nonce, protocol: PROTOCOL_VERSION, contract: PROTOCOL_CONTRACT });
    readJson(socket, value => {
      if (value.kind === 'auth') {
        const clientId = String(value.clientId);
        const hmac = createHmac('sha256', credential).update(`server:${PROTOCOL_VERSION}:${clientId}:${nonce}`).digest('hex');
        sendJson(socket, { kind: 'authenticated', principal: clientId, epoch: 'partial-handshake-epoch', contract: PROTOCOL_CONTRACT, hmac });
      } else {
        receivedMethods.push(value.method);
      }
    });
  });
  outputServer.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    sendJson(socket, { kind: 'challenge', nonce, protocol: PROTOCOL_VERSION, contract: PROTOCOL_CONTRACT });
    readJson(socket, value => {
      if (value.kind !== 'auth') return;
      outputAuthenticated();
      controlSocket?.destroy();
      void controlDisconnected.then(() => {
        const clientId = String(value.clientId);
        const hmac = createHmac('sha256', credential).update(`server:${PROTOCOL_VERSION}:${clientId}:${nonce}`).digest('hex');
        if (!socket.destroyed) sendJson(socket, { kind: 'authenticated', principal: clientId, epoch: 'partial-handshake-epoch', contract: PROTOCOL_CONTRACT, hmac });
      });
    });
  });

  const client = new RuntimeClient({ autoLaunch: false });
  const internal = client as unknown as StartupInternals;
  const transportStates: string[] = [];
  const unsubscribe = client.onEvent(event => {
    if (event.event !== 'runtime.transport') return;
    const state = String((event.data as {state?: unknown}).state);
    transportStates.push(state);
    if (state === 'disconnected') disconnected();
  });
  try {
    await Promise.all([listen(controlServer, `${pipeBase}-control`), listen(outputServer, `${pipeBase}-output`)]);
    const request = client.request('runtime.health', {});
    await outputAuthReceived;
    await assert.rejects(request, /Runtime pipe closed/);
    client.setSuspended(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(internal.control, undefined);
    assert.equal(internal.output, undefined);
    assert.deepEqual(transportStates, ['disconnected']);
    assert.deepEqual(receivedMethods, [], 'the failed request is never written after the control pipe closes');
  } finally {
    unsubscribe();
    client.dispose();
    for (const socket of sockets) socket.destroy();
    await Promise.all([closeServer(controlServer), closeServer(outputServer)]);
    await rm(dataDirectory, { recursive: true, force: true });
    if (previousPipe === undefined) delete process.env.THREADTERM_V3_PIPE; else process.env.THREADTERM_V3_PIPE = previousPipe;
    if (previousData === undefined) delete process.env.THREADTERM_V3_DATA; else process.env.THREADTERM_V3_DATA = previousData;
  }
});

for (const scenario of [
  { kind: 'transient', error: new RuntimeUnavailableError('output authentication failed'), states: ['disconnected'] },
  { kind: 'incompatible', error: new ProtocolIncompatibleError('output protocol is incompatible'), states: ['incompatible'] },
] as const) {
  test(`a late control close cannot duplicate or override a ${scenario.kind} partial-handshake failure`, async () => {
    const client = new RuntimeClient();
    const internal = client as unknown as StartupInternals;
    const transportStates: string[] = [];
    const unsubscribe = client.onEvent(event => {
      if (event.event === 'runtime.transport') transportStates.push(String((event.data as {state?: unknown}).state));
    });
    let failureListener: ((error: Error) => void) | undefined;
    let closed = false;
    let lateFailure!: () => void;
    const lateFailureDelivered = new Promise<void>(resolve => { lateFailure = resolve; });
    const control = {
      write() {},
      close() {
        if (closed) return;
        closed = true;
        setImmediate(() => {
          failureListener?.(new RuntimeUnavailableError('control pipe closed'));
          lateFailure();
        });
      },
      onFrame() { return () => {}; },
      onFailure(listener: (error: Error) => void) { failureListener = listener; return () => { failureListener = undefined; }; },
    };
    internal.connectAndAuthenticate = async () => {
      internal.attachControl(control);
      control.close();
      throw scenario.error;
    };
    try {
      await assert.rejects(client.request('runtime.health', {}), scenario.error);
      client.setSuspended(true);
      await lateFailureDelivered;
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(transportStates, scenario.states);
    } finally {
      unsubscribe();
      client.dispose();
    }
  });
}

test('a stale malformed output frame cannot disconnect the replacement transport', async () => {
  const client = new RuntimeClient();
  const internal = client as unknown as ClientInternals;
  const stale = { write() {}, close() {} };
  const current = { write() {}, close() {} };
  internal.output = current;
  const states: string[] = [];
  const unsubscribe = client.onEvent(event => {
    if (event.event === 'runtime.transport') states.push(String((event.data as {state?: unknown}).state));
  });
  try {
    await internal.handleOutputFrame(Buffer.alloc(0), stale);
    assert.equal(internal.output, current);
    assert.deepEqual(states, []);
  } finally {
    unsubscribe();
    client.dispose();
  }
});

test('a stale control frame cannot publish an event from the replaced transport', () => {
  const client = new RuntimeClient();
  const internal = client as unknown as StartupInternals;
  let frameListener: ((frame: Buffer) => void) | undefined;
  const stale = {
    write() {},
    close() {},
    onFrame(listener: (frame: Buffer) => void) { frameListener = listener; return () => { frameListener = undefined; }; },
    onFailure() { return () => {}; },
  };
  const current = { write() {}, close() {} };
  internal.attachControl(stale);
  internal.control = current;
  const events: string[] = [];
  const unsubscribe = client.onEvent(event => { events.push(event.event); });
  try {
    frameListener?.(Buffer.from(JSON.stringify({
      v: 1, event: 'state.changed', epoch: 'stale', seq: 1, data: { kind: 'settings' },
    }), 'utf8'));
    assert.deepEqual(events, []);
    assert.equal(internal.control, current);
  } finally {
    unsubscribe();
    client.dispose();
  }
});

test('a stale output delivery failure cannot disconnect the replacement transport', async () => {
  const client = new RuntimeClient();
  const internal = client as unknown as ClientInternals;
  internal.control = { write() {}, close() {} };
  const stale = { write() {}, close() {} };
  const current = { write() {}, close() {} };
  internal.output = stale;
  let deliveryStarted!: () => void;
  const started = new Promise<void>(resolve => { deliveryStarted = resolve; });
  let rejectDelivery!: (error: Error) => void;
  const heldDelivery = new Promise<void>((_, reject) => { rejectDelivery = reject; });
  const unsubscribeOutput = await client.subscribeOutput('stale-delivery', 0, async () => {
    deliveryStarted();
    await heldDelivery;
  });
  const states: string[] = [];
  const unsubscribeEvent = client.onEvent(event => {
    if (event.event === 'runtime.transport') states.push(String((event.data as {state?: unknown}).state));
  });
  try {
    const pending = internal.handleOutputFrame(outputFrame('stale-delivery', 0, Uint8Array.of(1)), stale);
    await started;
    internal.output = current;
    rejectDelivery(new Error('stale consumer failed'));
    await assert.rejects(pending, /stale consumer failed/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(internal.output, current);
    assert.deepEqual(states, []);
  } finally {
    unsubscribeOutput();
    unsubscribeEvent();
    client.dispose();
  }
});

function clientWithPipes(): { client: RuntimeClient; writes: Buffer[] } {
  const client = new RuntimeClient();
  const writes: Buffer[] = [];
  const internal = client as unknown as ClientInternals;
  internal.control = { write() {}, close() {} };
  internal.output = { write(payload) { writes.push(payload); }, close() {} };
  return { client, writes };
}

function outputFrame(sessionId: string, cursor: number, data: Uint8Array): Buffer {
  const header = Buffer.from(JSON.stringify({ sessionId, cursor }), 'utf8');
  const frame = Buffer.alloc(5 + header.length + data.byteLength);
  frame.writeUInt8(1, 0);
  frame.writeUInt32LE(header.length, 1);
  header.copy(frame, 5);
  Buffer.from(data).copy(frame, 5 + header.length);
  return frame;
}

function gapFrame(sessionId: string, cursor: number): Buffer {
  const header = Buffer.from(JSON.stringify({ sessionId, cursor }), 'utf8');
  const frame = Buffer.alloc(5 + header.length);
  frame.writeUInt8(4, 0);
  frame.writeUInt32LE(header.length, 1);
  header.copy(frame, 5);
  return frame;
}

test('disposed clients reject new work instead of reopening runtime pipes', async () => {
  const { client } = clientWithPipes();
  client.dispose();
  await assert.rejects(client.request('runtime.health', {}), /Desktop is closing/);
  await assert.rejects(client.subscribeOutput('closed', 0, () => {}), /Desktop is closing/);
});

test('QA control-drop hook is unavailable without the existing QA flag and closes only the control pipe with it', async () => {
  const previous = process.env.THREADTERM_V3_RELOCATION_QA;
  try {
    delete process.env.THREADTERM_V3_RELOCATION_QA;
    const off = clientWithPipes();
    let offClosed = 0;
    (off.client as unknown as ClientInternals).control = { write() {}, close() { offClosed++; } };
    assert.equal(off.client.dropControlForQa(), false);
    assert.equal(offClosed, 0);

    process.env.THREADTERM_V3_RELOCATION_QA = '1';
    const on = clientWithPipes();
    let controlClosed = 0;
    let outputClosed = 0;
    const internal = on.client as unknown as ClientInternals;
    internal.control = { write() {}, close() { controlClosed++; } };
    internal.output = { write() {}, close() { outputClosed++; } };
    assert.equal(on.client.dropControlForQa(), true);
    assert.equal(controlClosed, 1);
    assert.equal(outputClosed, 0, 'the hook itself only cuts control; normal socket failure owns output teardown');
    await assert.rejects(on.client.request('runtime.health', {}), /paused for QA/, 'incidental renderer requests cannot reconnect during the staged gap');
    await assert.rejects(on.client.subscribeOutput('s', 0, () => {}), /paused for QA/, 'output subscriptions cannot reopen the paused pipes');
    assert.equal(on.client.resumeControlForQa(), true, 'the explicit QA resume re-enables the normal reconnect path');
    assert.equal(on.client.resumeControlForQa(), false, 'only one QA resume is accepted for a pause');
  } finally {
    if (previous === undefined) delete process.env.THREADTERM_V3_RELOCATION_QA;
    else process.env.THREADTERM_V3_RELOCATION_QA = previous;
  }
});

test('shutdown suspension rejects new work and preserves subscriptions for a cancelled shutdown', async () => {
  const { client } = clientWithPipes();
  const internal = client as unknown as ClientInternals;
  const received: number[] = [];
  await client.subscribeOutput('running', 0, chunk => { received.push(chunk.data.length); });
  client.setSuspended(true);
  await assert.rejects(client.request('runtime.health', {}), /shutdown is in progress/);
  assert.equal(internal.outputGroups.size, 1);
  client.setSuspended(false);
  await internal.handleOutputFrame(outputFrame('running', 0, Uint8Array.of(1, 2)));
  assert.deepEqual(received, [2]);
  client.dispose();
});

test('late shared consumer gets empty history immediately without rewinding the upstream cursor', async () => {
  const { client, writes } = clientWithPipes();
  const first: number[] = [];
  const late: number[] = [];
  await client.subscribeOutput('empty', 0, (chunk) => { first.push(chunk.data.byteLength); });
  await client.subscribeOutput('empty', 0, (chunk) => { late.push(chunk.data.byteLength); });
  assert.deepEqual(first, []);
  assert.deepEqual(late, []);
  // One subscribe + one initial credit only: the late reader did not rewind
  // the shared daemon stream.
  assert.equal(writes.length, 2);
  client.dispose();
});

test('late shared consumer backfills over 64 KiB before receiving queued live bytes', async () => {
  const { client } = clientWithPipes();
  const internal = client as unknown as ClientInternals;
  const sessionId = 'large';
  const history = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
  const live = Uint8Array.of(251, 252, 253);
  const first: Uint8Array[] = [];
  const late: Uint8Array[] = [];
  await client.subscribeOutput(sessionId, 0, (chunk) => { first.push(chunk.data); });
  await internal.handleOutputFrame(outputFrame(sessionId, 0, history));

  let firstReadStarted!: () => void;
  const firstRead = new Promise<void>((resolve) => { firstReadStarted = resolve; });
  let releaseFirstRead!: () => void;
  const heldFirstRead = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
  let reads = 0;
  internal.request = (async (_method, params) => {
    assert.equal(params.sessionId, sessionId);
    assert.equal(params.limit, 64 * 1024);
    reads++;
    if (reads === 1) { firstReadStarted(); await heldFirstRead; }
    const cursor = Number(params.cursor);
    const nextCursor = Math.min(history.byteLength, cursor + 64 * 1024);
    return {
      sessionId,
      fromCursor: cursor,
      nextCursor,
      truncated: false,
      encoding: 'base64',
      data: Buffer.from(history.slice(cursor, nextCursor)).toString('base64'),
    };
  }) as RuntimeClient['request'];

  const subscribeLate = client.subscribeOutput(sessionId, 0, (chunk) => { late.push(chunk.data); });
  await firstRead;
  const queuedLive = internal.handleOutputFrame(outputFrame(sessionId, history.byteLength, live));
  releaseFirstRead();
  await subscribeLate;
  await queuedLive;

  assert.equal(reads, 2);
  assert.deepEqual(Buffer.concat(first.map((data) => Buffer.from(data))), Buffer.concat([Buffer.from(history), Buffer.from(live)]));
  assert.deepEqual(Buffer.concat(late.map((data) => Buffer.from(data))), Buffer.concat([Buffer.from(history), Buffer.from(live)]));
  client.dispose();
});

test('gap-only page at the captured boundary completes the late consumer', async () => {
  const { client } = clientWithPipes();
  const internal = client as unknown as ClientInternals;
  await client.subscribeOutput('trimmed', 0, () => undefined);
  await internal.handleOutputFrame(outputFrame('trimmed', 0, Uint8Array.of(1, 2, 3, 4)));
  const gaps: number[] = [];
  internal.request = (async () => ({
    sessionId: 'trimmed', fromCursor: 4, nextCursor: 4, truncated: true,
    encoding: 'base64', data: '',
  })) as RuntimeClient['request'];
  await client.subscribeOutput('trimmed', 0, (chunk) => { if (chunk.gap) gaps.push(chunk.cursor); });
  assert.deepEqual(gaps, [4]);
  client.dispose();
});

test('a runtime gap advances only its group and preserves later live output', async () => {
  const { client } = clientWithPipes();
  const internal = client as unknown as ClientInternals;
  const gapped: Array<{ cursor: number; gap: boolean; data: number[] }> = [];
  const healthy: number[] = [];
  await client.subscribeOutput('gapped', 0, (chunk) => {
    gapped.push({ cursor: chunk.cursor, gap: Boolean(chunk.gap), data: [...chunk.data] });
  });
  await client.subscribeOutput('healthy', 0, (chunk) => { healthy.push(...chunk.data); });

  await internal.handleOutputFrame(gapFrame('gapped', 96));
  assert.equal(internal.outputGroups.get('gapped')?.cursor, 96, 'gap moves its shared reconnect watermark forward');
  assert.equal(internal.outputGroups.get('healthy')?.cursor, 0, 'unrelated output group is unchanged');

  await internal.handleOutputFrame(outputFrame('gapped', 96, Uint8Array.of(7, 8)));
  await internal.handleOutputFrame(outputFrame('healthy', 0, Uint8Array.of(4, 5)));
  assert.deepEqual(gapped, [
    { cursor: 96, gap: true, data: [] },
    { cursor: 96, gap: false, data: [7, 8] },
  ]);
  assert.deepEqual(healthy, [4, 5]);
  assert.equal(internal.outputGroups.get('gapped')?.cursor, 98, 'subsequent live bytes continue from the gap end');
  assert.equal(internal.outputGroups.get('healthy')?.cursor, 2, 'healthy group advances normally');
  client.dispose();
});

test('a pending old frame cannot credit a reconnected or disposed output pipe', async () => {
  const { client, writes } = clientWithPipes();
  const internal = client as unknown as ClientInternals;
  let entered!: () => void;
  const enteredDelivery = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const heldDelivery = new Promise<void>((resolve) => { release = resolve; });
  await client.subscribeOutput('pending', 0, async () => { entered(); await heldDelivery; });
  const pending = internal.handleOutputFrame(outputFrame('pending', 0, Uint8Array.of(9)));
  await enteredDelivery;
  const reconnectedWrites: Buffer[] = [];
  internal.output = { write(payload) { reconnectedWrites.push(payload); }, close() {} };
  release();
  await pending;
  assert.equal(writes.length, 2, 'old delayed output must not credit after reconnect');
  assert.equal(reconnectedWrites.length, 0, 'old delayed output must not credit the new pipe');

  let secondEntered!: () => void;
  const secondStarted = new Promise<void>((resolve) => { secondEntered = resolve; });
  let secondRelease!: () => void;
  const secondHeld = new Promise<void>((resolve) => { secondRelease = resolve; });
  const unsubscribe = await client.subscribeOutput('disposed', 0, async () => { secondEntered(); await secondHeld; });
  const beforeDispose = reconnectedWrites.length;
  const pendingDisposed = internal.handleOutputFrame(outputFrame('disposed', 0, Uint8Array.of(10)));
  await secondStarted;
  client.dispose();
  secondRelease();
  await pendingDisposed;
  assert.equal(reconnectedWrites.length, beforeDispose, 'disposed client must not pay delayed credits');
  unsubscribe();
});
