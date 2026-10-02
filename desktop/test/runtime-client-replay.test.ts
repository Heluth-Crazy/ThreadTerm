import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeClient } from '../src/runtime-client.js';

type ClientInternals = {
  control?: { write(payload: Buffer): void; close(): void };
  output?: { write(payload: Buffer): void; close(): void };
  outputGroups: Map<string, { cursor: number }>;
  request: RuntimeClient['request'];
  handleOutputFrame(frame: Buffer): Promise<void>;
};

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
