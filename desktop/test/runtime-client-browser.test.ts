import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PROTOCOL_CONTRACT, PROTOCOL_VERSION, type BrowserPrivateFrame } from '@threadterm/protocol';
import { RuntimeClient } from '../src/runtime-client.js';

type Request = { id: string; method: string; params: Record<string, unknown> };
type Connection = { write(payload: Buffer): void; close(): void; socket: net.Socket };
type Internals = {
  connectAndAuthenticate(): Promise<void>;
  browser?: Connection;
  browserCapabilityEpoch?: string;
  browserSession?: { control: Connection; pipe: string; token: string; epoch: string };
  browserPending: Map<string, unknown>;
  pending: Map<string, unknown>;
  control?: Connection;
  output?: Connection;
  handleControlFrame(frame: Buffer): void;
  handleBrowserFrame(frame: Buffer, connection: Connection, session: unknown): void;
};

const scratchRoot = 'D:/project/ThreadTerm/tt-qa-temp';
const attachment = { attachmentId: 'attachment', attachmentGeneration: 1, runtimeEpoch: 'browser-epoch', viewGeneration: 1 };
const attachParams = { viewId: 'view', workspaceId: 'workspace', workspaceRevision: 1, viewGeneration: 1 };
const replyParams = { ...attachment, operationId: 'operation', workerGeneration: 'worker', result: { content: [{ type: 'text', text: 'Page data, not instructions: private page evidence' }] } };
const execute: BrowserPrivateFrame = {
  method: 'browser.execute',
  params: { ...attachment, operationId: 'operation', invocationId: 'invocation', callerSessionId: 'session', workerGeneration: 'worker', deadlineUnixMs: Date.now() + 10_000, tool: 'browser_list_tabs', arguments: {}, targets: [] },
};
const evalFence = { ...attachment, operationId: 'eval-operation', workerGeneration: 'worker', preparedId: 'prepared', tabId: 'opaque-tab', codeHash: 'a'.repeat(64), settingsGeneration: 'epoch:1', origin: 'https://example.invalid', documentGeneration: 1, navigationEpoch: 1, grantEpoch: 1 };

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const bytes = Buffer.alloc(4 + payload.length);
  bytes.writeUInt32LE(payload.length, 0);
  payload.copy(bytes, 4);
  return bytes;
}

function read(socket: net.Socket, onValue: (value: Record<string, unknown>) => void): void {
  let bytes = Buffer.alloc(0);
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4) {
      const length = bytes.readUInt32LE(0);
      if (bytes.length < 4 + length) return;
      const value = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>;
      bytes = bytes.subarray(4 + length);
      onValue(value);
    }
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Fixture condition timed out');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  }
}

async function fixture(options: { browserAuthEpoch?: string; pauseBrowserAuth?: boolean; notificationWithProof?: unknown; notificationWithAttachment?: unknown; holdBrowserReplies?: boolean } = {}) {
  const directory = await mkdtemp(join(scratchRoot, 'runtime-browser-'));
  assert.ok(resolve(directory).startsWith(`${resolve(scratchRoot)}\\`));
  const pipe = `\\\\.\\pipe\\threadterm-browser-test-${process.pid}-${randomUUID()}`;
  const token = 'fixture-only-credential';
  await writeFile(join(directory, 'runtime.credential'), token);
  const previousPipe = process.env.THREADTERM_V3_PIPE;
  const previousData = process.env.THREADTERM_V3_DATA;
  process.env.THREADTERM_V3_PIPE = pipe;
  process.env.THREADTERM_V3_DATA = directory;
  const client = new RuntimeClient({ autoLaunch: false });
  const internal = client as unknown as Internals;
  const sockets = new Set<net.Socket>();
  const servers: net.Server[] = [];
  const requests: { lane: string; request: Request }[] = [];
  const principals = new Map<string, string>();
  let browserSocket: net.Socket | undefined;
  let browserConnections = 0;
  let releaseAuth: (() => void) | undefined;
  let holdBrowserReplies = options.holdBrowserReplies;
  let capabilityEpoch = attachment.runtimeEpoch;
  for (const lane of ['control', 'output', 'browser']) {
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      if (lane === 'browser') { browserConnections++; browserSocket = socket; }
      const nonce = `nonce-${lane}`;
      socket.write(frame({ kind: 'challenge', nonce, protocol: PROTOCOL_VERSION, contract: PROTOCOL_CONTRACT }));
      read(socket, value => {
        if (value.kind === 'auth') {
          const principal = String(value.clientId);
          principals.set(lane, principal);
          assert.equal(value.hmac, createHmac('sha256', token).update(`${PROTOCOL_VERSION}:${principal}:${nonce}`).digest('hex'));
          const authenticate = () => {
            const proof = frame({ kind: 'authenticated', principal, epoch: lane === 'browser' ? options.browserAuthEpoch ?? 'epoch' : 'epoch', contract: PROTOCOL_CONTRACT, hmac: createHmac('sha256', token).update(`server:${PROTOCOL_VERSION}:${principal}:${nonce}`).digest('hex') });
            socket.write(lane === 'browser' && options.notificationWithProof ? Buffer.concat([proof, frame(options.notificationWithProof)]) : proof);
          };
          if (lane === 'browser' && options.pauseBrowserAuth) releaseAuth = authenticate;
          else authenticate();
          return;
        }
        const request = value as unknown as Request;
        requests.push({ lane, request });
        if (lane !== 'browser' || holdBrowserReplies) return;
        const currentAttachment = { ...attachment, runtimeEpoch: capabilityEpoch };
        const result = request.method === 'browser.attach' ? currentAttachment : request.method === 'browser.desktop.reply' || request.method === 'browser.desktop.dispatch' ? { accepted: true } : request.method === 'browser.detach' ? { detached: true } : request.method === 'browser.unregisterTab' ? { unregistered: true } : { ...currentAttachment, sourceTabId: request.params.sourceTabId, tabId: 'public-tab' };
        const response = frame({ v: 1, id: request.id, result });
        socket.write(request.method === 'browser.attach' && options.notificationWithAttachment ? Buffer.concat([response, frame(options.notificationWithAttachment)]) : response);
      });
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(`${pipe}-${lane}`, () => { server.off('error', reject); resolvePromise(); });
    });
    servers.push(server);
  }
  return {
    client, internal, requests, principals,
    get browserConnections() { return browserConnections; },
    get browserSocket() { return browserSocket!; },
    get authPaused() { return Boolean(releaseAuth); },
    releaseAuth() { releaseAuth?.(); },
    holdReplies(value: boolean) { holdBrowserReplies = value; },
    setCapabilityEpoch(value: string) { capabilityEpoch = value; },
    async close() {
      client.dispose();
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map(server => new Promise<void>(resolvePromise => server.close(() => resolvePromise()))));
      if (previousPipe === undefined) delete process.env.THREADTERM_V3_PIPE; else process.env.THREADTERM_V3_PIPE = previousPipe;
      if (previousData === undefined) delete process.env.THREADTERM_V3_DATA; else process.env.THREADTERM_V3_DATA = previousData;
      assert.ok(resolve(directory).startsWith(`${resolve(scratchRoot)}\\`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('browser stays idle until explicit attachment and shares the authenticated primary principal', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.client.browserRequest('browser.attach', attachParams), /control session is unavailable/);
    assert.equal(f.browserConnections, 0, 'browser requests never start the ordinary runtime connection');
    await f.internal.connectAndAuthenticate();
    await new Promise(resolvePromise => setImmediate(resolvePromise));
    assert.equal(f.browserConnections, 0, 'ordinary startup does not probe browser availability');
    await assert.rejects(f.client.browserRequest('browser.desktop.reply', replyParams), /attachment connection is unavailable/);
    assert.deepEqual(await f.client.browserRequest('browser.attach', attachParams), attachment);
    assert.equal(f.browserConnections, 1);
    assert.equal(f.principals.get('browser'), f.principals.get('control'));
    assert.equal(f.principals.get('browser'), f.principals.get('output'));
    await assert.rejects(f.client.browserRequest('runtime.health' as never, {}), /Invalid private browser request/);
    await assert.rejects(f.client.browserRequest('browser.attach', { ...attachParams, token: 'forged' }), /Invalid private browser request/);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

for (const notification of [execute, { method: 'browser.cancel', params: { ...attachment, operationId: 'operation', workerGeneration: 'worker', reason: 'cancelled' } }] as const) {
  test(`coalesced private proof/${notification.method} before attachment fails closed without renderer fanout`, async () => {
    const f = await fixture({ notificationWithProof: notification });
    const ordinary: unknown[] = [], privateFrames: BrowserPrivateFrame[] = [];
    f.client.onEvent(value => ordinary.push(value));
    f.client.onBrowserFrame(value => privateFrames.push(value));
    try {
      await f.internal.connectAndAuthenticate();
      await assert.rejects(f.client.browserRequest('browser.attach', attachParams), /attachment has not been established/);
      assert.deepEqual(privateFrames, []);
      assert.deepEqual(ordinary, []);
      assert.equal(f.internal.browserCapabilityEpoch, undefined);
      assert.ok(f.internal.control);
    } finally { await f.close(); }
  });
}

test('coalesced attachment response/execute learns the fresh capability epoch before dispatch', async () => {
  const f = await fixture({ notificationWithAttachment: execute });
  const ordinary: unknown[] = [], privateFrames: BrowserPrivateFrame[] = [];
  f.client.onEvent(value => ordinary.push(value));
  const unsubscribe = f.client.onBrowserFrame(value => {
    assert.equal(f.internal.browserCapabilityEpoch, attachment.runtimeEpoch);
    privateFrames.push(value);
  });
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    assert.notEqual(f.internal.browserCapabilityEpoch, f.internal.browserSession?.epoch, 'capability and authenticated DB epochs are independent');
    assert.deepEqual(privateFrames, [execute]);
    assert.deepEqual(ordinary, []);
    unsubscribe();
    f.browserSocket.write(frame(execute));
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    assert.equal(privateFrames.length, 1);
    assert.deepEqual(ordinary, []);
  } finally { await f.close(); }
});

test('ordinary read saturation cannot starve private desktop replies', async () => {
  const f = await fixture();
  const reads: Promise<unknown>[] = [];
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    for (let index = 0; index < 16; index++) reads.push(f.client.request('terminal.read', { sessionId: `session-${index}`, cursor: 0, limit: 1 }).catch(error => error));
    await waitUntil(() => f.requests.filter(value => value.lane === 'control').length === 16);
    assert.equal(f.internal.pending.size, 16);
    assert.deepEqual(await f.client.browserRequest('browser.desktop.reply', replyParams), { accepted: true });
    assert.equal(f.internal.pending.size, 16, 'no ordinary reply was needed to release browser reply');
    assert.equal(f.requests.at(-1)?.lane, 'browser');
  } finally { await f.close(); await Promise.all(reads); }
});

test('browser failures drain pending calls, revoke main state and require explicit reattachment', async () => {
  const f = await fixture();
  const losses: Error[] = [];
  f.client.onBrowserDisconnect(error => losses.push(error));
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    f.holdReplies(true);
    const pending = f.client.browserRequest('browser.desktop.reply', replyParams);
    const rejected = assert.rejects(pending, /pipe closed/);
    await waitUntil(() => f.requests.some(value => value.request.method === 'browser.desktop.reply'));
    f.browserSocket.destroy();
    await rejected;
    assert.equal(f.internal.browserPending.size, 0);
    assert.equal(losses.length, 1);
    await assert.rejects(f.client.browserRequest('browser.desktop.reply', replyParams), /attachment connection is unavailable/);
    assert.equal(f.browserConnections, 1, 'reply failure never silently reauthenticates');
    assert.ok(f.internal.control);
    assert.ok(f.internal.output);
    f.holdReplies(false);
    await f.client.browserRequest('browser.attach', attachParams);
    assert.equal(f.browserConnections, 2, 'a new explicit attachment may establish a new channel');
  } finally { await f.close(); }
});

test('primary control loss clears browser credentials and pending requests before main observes the loss', async () => {
  const f = await fixture();
  const losses: Error[] = [];
  f.client.onBrowserDisconnect(error => {
    losses.push(error);
    assert.equal(f.internal.control, undefined);
    assert.equal(f.internal.browserSession, undefined);
  });
  f.client.onEvent(value => { if (value.event === 'runtime.transport') f.client.setSuspended(true); });
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    f.holdReplies(true);
    const rejected = assert.rejects(f.client.browserRequest('browser.desktop.reply', replyParams), /pipe closed/);
    f.internal.control!.close();
    await rejected;
    assert.equal(losses.length, 1);
    assert.equal(f.internal.browserPending.size, 0);
    assert.equal(f.internal.browser, undefined);
  } finally { await f.close(); }
});

test('late frames and failures from a replaced browser socket cannot damage its replacement', async () => {
  const f = await fixture();
  const losses: Error[] = [];
  f.client.onBrowserDisconnect(error => losses.push(error));
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    const oldConnection = f.internal.browser!;
    const oldSession = f.internal.browserSession;
    f.browserSocket.destroy();
    await waitUntil(() => losses.length === 1);
    await f.client.browserRequest('browser.attach', attachParams);
    const replacement = f.internal.browser;
    assert.notEqual(replacement, oldConnection);
    f.internal.handleBrowserFrame(Buffer.from('invalid JSON'), oldConnection, oldSession);
    oldConnection.socket.emit('close');
    assert.equal(f.internal.browser, replacement);
    assert.equal(losses.length, 1);
    assert.deepEqual(await f.client.browserRequest('browser.desktop.reply', replyParams), { accepted: true });
  } finally { await f.close(); }
});

test('a pending browser timeout closes the private channel and clears every pending timer', async context => {
  const f = await fixture();
  const losses: Error[] = [];
  f.client.onBrowserDisconnect(error => losses.push(error));
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    f.holdReplies(true);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const rejected = assert.rejects(f.client.browserRequest('browser.desktop.reply', replyParams), /timed out/);
    context.mock.timers.tick(10_000);
    await rejected;
    assert.equal(f.internal.browserPending.size, 0);
    assert.equal(f.internal.browser, undefined);
    assert.equal(losses.length, 1);
    assert.ok(f.internal.control);
  } finally { context.mock.timers.reset(); await f.close(); }
});

for (const notification of [
  { method: 'browser.future', params: { secret: 'private' } },
  { v: 1, event: 'state.changed', epoch: 'epoch', seq: 1, data: { private: 'content' } },
  { ...execute, params: { ...execute.params, runtimeEpoch: 'foreign-epoch' } },
]) {
  test(`private channel rejects ${'method' in notification ? notification.method : notification.event} without renderer fanout`, async () => {
    const f = await fixture();
    const events: unknown[] = [], losses: Error[] = [], frames: unknown[] = [];
    f.client.onEvent(value => events.push(value));
    f.client.onBrowserFrame(value => frames.push(value));
    f.client.onBrowserDisconnect(error => losses.push(error));
    try {
      await f.internal.connectAndAuthenticate();
      await f.client.browserRequest('browser.attach', attachParams);
      f.browserSocket.write(frame(notification));
      await waitUntil(() => losses.length > 0);
      assert.deepEqual(events, []);
      assert.deepEqual(frames, []);
      assert.ok(f.internal.control, 'private protocol failure leaves ordinary transport alive');
    } finally { await f.close(); }
  });
}

test('browser-prefixed durable events are blocked before ordinary control fanout', async () => {
  const client = new RuntimeClient({ autoLaunch: false });
  const internal = client as unknown as Internals;
  const events: string[] = [];
  client.onEvent(value => events.push(value.event));
  client.setSuspended(true);
  try {
    internal.handleControlFrame(Buffer.from(JSON.stringify({ v: 1, event: 'browser.future', epoch: 'epoch', seq: 1, data: { private: 'content' } })));
    assert.deepEqual(events, ['runtime.transport']);
  } finally { client.dispose(); }
});

test('a browser authentication epoch mismatch rejects attachment without damaging primary transport', async () => {
  const f = await fixture({ browserAuthEpoch: 'replacement-epoch' });
  try {
    await f.internal.connectAndAuthenticate();
    await assert.rejects(f.client.browserRequest('browser.attach', attachParams), /epoch changed/);
    assert.equal(f.internal.browser, undefined);
    assert.equal(f.internal.browserPending.size, 0);
    assert.ok(f.internal.control);
    assert.equal(f.requests.length, 0, 'no registration crosses an epoch mismatch');
  } finally { await f.close(); }
});

test('registering a tab cannot establish a capability epoch before successful attachment', async () => {
  const f = await fixture();
  try {
    await f.internal.connectAndAuthenticate();
    await assert.rejects(f.client.browserRequest('browser.registerTab', { attachmentId: 'attachment', attachmentGeneration: 1, sourceTabId: 'tab', workspaceRevision: 1 }), /attachment is unavailable/);
    assert.equal(f.internal.browserCapabilityEpoch, undefined);
    assert.equal(f.requests.length, 0);
    await f.client.browserRequest('browser.attach', attachParams);
    assert.equal(f.internal.browserCapabilityEpoch, attachment.runtimeEpoch);
  } finally { await f.close(); }
});

for (const method of ['browser.attach', 'browser.registerTab'] as const) {
  test(`a later ${method} response cannot replace the private connection's capability epoch`, async () => {
    const f = await fixture();
    try {
      await f.internal.connectAndAuthenticate();
      await f.client.browserRequest('browser.attach', attachParams);
      f.setCapabilityEpoch('stale-browser-epoch');
      await assert.rejects(f.client.browserRequest(method, method === 'browser.attach' ? attachParams : { attachmentId: 'attachment', attachmentGeneration: 1, sourceTabId: 'tab', workspaceRevision: 1 }), /capability epoch changed/);
      assert.equal(f.internal.browser, undefined);
      assert.equal(f.internal.browserCapabilityEpoch, undefined);
      assert.equal(f.internal.browserPending.size, 0);
      assert.ok(f.internal.control);
    } finally { await f.close(); }
  });
}

test('runtime replacement with the same DB epoch clears browser authority and rejects old notifications and replies', async () => {
  const f = await fixture();
  const privateFrames: BrowserPrivateFrame[] = [], losses: Error[] = [];
  f.client.onBrowserFrame(value => privateFrames.push(value));
  f.client.onBrowserDisconnect(error => losses.push(error));
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    const oldConnection = f.internal.browser!;
    const oldSession = f.internal.browserSession!;
    f.holdReplies(true);
    const rejected = assert.rejects(f.client.browserRequest('browser.desktop.reply', replyParams), /control session was replaced/);
    await waitUntil(() => f.requests.some(value => value.request.method === 'browser.desktop.reply'));
    f.setCapabilityEpoch('restarted-browser-epoch');
    await f.internal.connectAndAuthenticate();
    await rejected;
    assert.equal(f.internal.browserSession?.epoch, oldSession.epoch, 'database authentication epoch survives the service restart');
    assert.equal(f.internal.browserCapabilityEpoch, undefined);
    assert.equal(f.internal.browser, undefined);
    assert.equal(f.browserConnections, 1, 'primary replacement does not restore a private attachment');
    f.internal.handleBrowserFrame(Buffer.from(JSON.stringify(execute)), oldConnection, oldSession);
    assert.deepEqual(privateFrames, []);
    f.holdReplies(false);
    const result = await f.client.browserRequest('browser.attach', attachParams);
    assert.deepEqual(result, { ...attachment, runtimeEpoch: 'restarted-browser-epoch' });
    assert.equal(f.internal.browserCapabilityEpoch, 'restarted-browser-epoch');
    const sent = f.requests.length;
    await assert.rejects(f.client.browserRequest('browser.desktop.reply', replyParams), /capability epoch changed/);
    assert.equal(f.requests.length, sent, 'old results never reach the replacement broker');
    assert.equal(losses.length, 1);
    f.browserSocket.write(frame(execute));
    await waitUntil(() => losses.length === 2);
    assert.deepEqual(privateFrames, []);
    assert.equal(f.internal.browserCapabilityEpoch, undefined);
    assert.ok(f.internal.control);
  } finally { await f.close(); }
});

test('suspend/resume stays idle and a fresh explicit attachment restores only the private connection', async () => {
  const f = await fixture();
  const losses: Error[] = [];
  f.client.onBrowserDisconnect(error => losses.push(error));
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    const control = f.internal.control;
    f.client.setSuspended(true);
    assert.equal(f.internal.browserSession, undefined);
    assert.equal(f.internal.browser, undefined);
    assert.equal(f.internal.browserCapabilityEpoch, undefined);
    assert.equal(losses.length, 1);
    f.client.setSuspended(false);
    await new Promise(resolvePromise => setImmediate(resolvePromise));
    assert.equal(f.internal.control, control);
    assert.equal(f.browserConnections, 1, 'resume neither probes nor restores a browser attachment');
    await assert.rejects(f.client.browserRequest('browser.desktop.reply', replyParams), /control session is unavailable/);
    await f.client.browserRequest('browser.attach', attachParams);
    assert.equal(f.browserConnections, 2);
    assert.equal(f.internal.control, control, 'explicit browser reattachment preserves ordinary control');
  } finally { await f.close(); }
});

test('suspension during an explicit credential refresh fences that refresh before a newer attachment', async () => {
  const f = await fixture();
  try {
    await f.internal.connectAndAuthenticate();
    f.client.setSuspended(true);
    f.client.setSuspended(false);
    const rejected = assert.rejects(f.client.browserRequest('browser.attach', attachParams), /shutdown/);
    f.client.setSuspended(true);
    f.client.setSuspended(false);
    await rejected;
    await f.client.browserRequest('browser.attach', attachParams);
    assert.equal(f.browserConnections, 1, 'the superseded refresh cannot open a stale private pipe');
  } finally { await f.close(); }
});

test('request admission snapshots validated parameters before asynchronous authentication', async () => {
  const f = await fixture({ pauseBrowserAuth: true });
  try {
    await f.internal.connectAndAuthenticate();
    const mutable = { ...attachParams };
    const attached = f.client.browserRequest('browser.attach', mutable);
    mutable.viewId = 'replacement-view';
    await waitUntil(() => f.authPaused);
    f.releaseAuth();
    await attached;
    assert.deepEqual(f.requests[0].request.params, attachParams);
  } finally { await f.close(); }
});

for (const interrupt of ['dispose', 'suspend', 'replace'] as const) {
  test(`${interrupt} while browser authentication waits cannot install the stale connection`, async () => {
    const f = await fixture({ pauseBrowserAuth: true });
    const losses: Error[] = [];
    f.client.onBrowserDisconnect(error => losses.push(error));
    try {
      await f.internal.connectAndAuthenticate();
      const attach = f.client.browserRequest('browser.attach', attachParams);
      const rejected = assert.rejects(attach, /closing|shutdown|replaced/);
      await waitUntil(() => f.authPaused);
      if (interrupt === 'dispose') f.client.dispose();
      else if (interrupt === 'suspend') f.client.setSuspended(true);
      else await f.internal.connectAndAuthenticate();
      f.releaseAuth();
      await rejected;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
      assert.equal(f.internal.browser, undefined);
      assert.equal(f.internal.browserPending.size, 0);
      assert.equal(losses.length, 1);
      assert.equal(f.requests.length, 0);
      if (interrupt !== 'replace') assert.equal(f.internal.browserSession, undefined);
    } finally { await f.close(); }
  });
}

test('browser registration saturation reserves private desktop reply capacity and drains on shutdown', async () => {
  const f = await fixture();
  const registrations: Promise<unknown>[] = [];
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    f.holdReplies(true);
    for (let index = 0; index < 48; index++) registrations.push(f.client.browserRequest('browser.registerTab', { attachmentId: 'attachment', attachmentGeneration: 1, sourceTabId: `tab-${index}`, workspaceRevision: 1 }).catch(error => error));
    await assert.rejects(f.client.browserRequest('browser.registerTab', { attachmentId: 'attachment', attachmentGeneration: 1, sourceTabId: 'excess', workspaceRevision: 1 }), /capacity/);
    const reply = f.client.browserRequest('browser.desktop.reply', replyParams);
    const rejected = assert.rejects(reply, /closing/);
    await waitUntil(() => f.requests.some(value => value.request.method === 'browser.desktop.reply'));
    assert.equal(f.internal.browserPending.size, 49);
    f.client.dispose();
    await rejected;
    assert.equal(f.internal.browserPending.size, 0);
  } finally { await f.close(); await Promise.all(registrations); }
});

test('pre-input dispatch uses reserved acknowledgement capacity under registration saturation', async () => {
  const f = await fixture();
  const registrations: Promise<unknown>[] = [];
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    f.holdReplies(true);
    for (let index = 0; index < 48; index++) registrations.push(f.client.browserRequest('browser.registerTab', { attachmentId: 'attachment', attachmentGeneration: 1, sourceTabId: `tab-${index}`, workspaceRevision: 1 }).catch(error => error));
    const dispatch = f.client.browserRequest('browser.desktop.dispatch', { ...attachment, operationId: 'action', workerGeneration: 'worker' });
    const rejected = assert.rejects(dispatch, /closing/);
    await waitUntil(() => f.requests.some(value => value.request.method === 'browser.desktop.dispatch'));
    assert.equal(f.internal.browserPending.size, 49);
    await assert.rejects(f.client.browserRequest('browser.registerTab', { attachmentId: 'attachment', attachmentGeneration: 1, sourceTabId: 'excess', workspaceRevision: 1 }), /capacity/);
    f.client.dispose();
    await rejected;
    assert.equal(f.internal.browserPending.size, 0);
  } finally { await f.close(); await Promise.all(registrations); }
});

test('pre-input dispatch rejects an old capability epoch without writing its request', async () => {
  const f = await fixture();
  const dispatch = { ...attachment, operationId: 'action', workerGeneration: 'worker' };
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    await assert.rejects(f.client.browserRequest('browser.desktop.dispatch', { ...dispatch, runtimeEpoch: 'retired' }), /capability epoch changed/);
    assert.equal(f.requests.some(value => value.request.method === 'browser.desktop.dispatch'), false);
    assert.deepEqual(await f.client.browserRequest('browser.desktop.dispatch', dispatch), { accepted: true });
    assert.equal(f.requests.filter(value => value.request.method === 'browser.desktop.dispatch').length, 1);
  } finally { await f.close(); }
});

for (const [method, params] of [
  ['browser.desktop.evalPrepared', evalFence],
  ['browser.desktop.evalInvalidated', { ...attachment, operationId: 'eval-operation', workerGeneration: 'worker', preparedId: 'prepared', reason: 'browser_cancelled' }],
] as const) {
  test(`${method} reserves acknowledgement capacity and rejects retired epochs`, async () => {
    const f = await fixture();
    const registrations: Promise<unknown>[] = [];
    try {
      await f.internal.connectAndAuthenticate();
      await f.client.browserRequest('browser.attach', attachParams);
      await assert.rejects(f.client.browserRequest(method, { ...params, runtimeEpoch: 'retired' }), /capability epoch changed/);
      assert.equal(f.requests.some(value => value.request.method === method), false);
      f.holdReplies(true);
      for (let index = 0; index < 48; index++) registrations.push(f.client.browserRequest('browser.registerTab', { attachmentId: 'attachment', attachmentGeneration: 1, sourceTabId: `tab-${index}`, workspaceRevision: 1 }).catch(error => error));
      const acknowledgement = f.client.browserRequest(method, params);
      const rejected = assert.rejects(acknowledgement, /closing/);
      await waitUntil(() => f.requests.some(value => value.request.method === method));
      assert.equal(f.internal.browserPending.size, 49);
      f.client.dispose();
      await rejected;
      assert.equal(f.internal.browserPending.size, 0);
    } finally { await f.close(); await Promise.all(registrations); }
  });
}

test('eval notifications remain private and malformed code never reaches either fanout', async () => {
  const f = await fixture();
  const privateFrames: BrowserPrivateFrame[] = [];
  const publicFrames: unknown[] = [];
  const losses: Error[] = [];
  f.client.onBrowserFrame(value => privateFrames.push(value));
  f.client.onEvent(value => publicFrames.push(value));
  f.client.onBrowserDisconnect(value => losses.push(value));
  try {
    await f.internal.connectAndAuthenticate();
    await f.client.browserRequest('browser.attach', attachParams);
    const prepare = { method: 'browser.eval.prepare', params: { ...attachment, operationId: 'eval-operation', workerGeneration: 'worker', invocationId: 'invocation', callerSessionId: 'session', turnId: 'turn', tabId: 'opaque-tab', codeHash: evalFence.codeHash, codeByteLength: 3, settingsGeneration: 'epoch:1', deadlineUnixMs: Date.now() + 10_000, target: { ...attachment, tabId: 'opaque-tab', sourceTabId: 'native-tab' } } };
    f.browserSocket.write(frame(prepare));
    await waitUntil(() => privateFrames.length === 1);
    assert.deepEqual(privateFrames[0], prepare);
    assert.deepEqual(publicFrames, []);
    f.browserSocket.write(frame({ ...prepare, params: { ...prepare.params, code: 'PRIVATE_CODE' } }));
    await waitUntil(() => losses.length === 1);
    assert.equal(privateFrames.length, 1);
    assert.deepEqual(publicFrames, []);
    assert.ok(f.internal.control, 'malformed private traffic invalidates only its private connection');
  } finally { await f.close(); }
});
