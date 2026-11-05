import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeClient } from '../runtime-client.ts';
import { LocalFileAccess } from './access.ts';
import { validateRequest } from '@threadterm/protocol';

type Internals = {
  ensureConnected(): Promise<void>;
  control?: { write(payload: Buffer): void; close(): void };
  handleControlFrame(frame: Buffer): void;
};

test('a connection failure before begin is sent cannot strand access cleanup', async () => {
  const client = new RuntimeClient({autoLaunch:false,controlOnly:true});
  let attempts = 0, ran = false;
  (client as unknown as Internals).ensureConnected = async () => { attempts++; throw new Error('connection unavailable'); };
  const access = new LocalFileAccess((method, params) => client.localFileRequest(method, params));
  try {
    await assert.rejects(access.run(async () => { ran = true; }), /connection unavailable/);
    assert.equal(ran, false);
    assert.equal(attempts, 1);
    await access.flush();
    assert.equal(attempts, 1);
  } finally { client.dispose(); }
});

test('a write failure after begin dispatch remains uncertain and retries release', async () => {
  const client = new RuntimeClient({autoLaunch:false,controlOnly:true});
  const internal = client as unknown as Internals;
  internal.ensureConnected = async () => {};
  let writes = 0, ran = false;
  internal.control = {close() {},write() { writes++; throw new Error('write failed'); }};
  const access = new LocalFileAccess((method, params) => client.localFileRequest(method, params));
  try {
    await assert.rejects(access.run(async () => { ran = true; }), /write failed/);
    assert.equal(ran, false);
    assert.equal(writes, 2);
    await assert.rejects(access.flush(), /write failed/);
    assert.equal(writes, 3);
  } finally { client.dispose(); }
});
test('private coordination validates responses and is absent from public renderer requests', async () => {
  const client = new RuntimeClient({ autoLaunch: false, controlOnly: true });
  const internal = client as unknown as Internals;
  internal.ensureConnected = async () => {};
  let result: unknown = { kind: 'workspace', projectId: 'p', rootPath: 'C:/fixture' };
  internal.control = { close() {}, write(bytes) {
    const request = JSON.parse(bytes.toString());
    queueMicrotask(() => internal.handleControlFrame(Buffer.from(JSON.stringify({ v: 1, id: request.id, result }))));
  } };
  try {
    assert.equal((await client.localFileRequest('desktop.files.context', { kind: 'workspace', projectId: 'p' }) as { projectId: string }).projectId, 'p');
    result = { kind: 'workspace', projectId: 'p', rootPath: null };
    await assert.rejects(client.localFileRequest('desktop.files.context', { kind: 'workspace', projectId: 'p' }), /Invalid local file coordination/);
    assert.throws(() => validateRequest('desktop.files.context', { kind: 'workspace', projectId: 'p' }), /Unsupported runtime method/);
    await assert.rejects(client.localFileRequest('filesystem.read', {}), /unavailable/);
  } finally { client.dispose(); }
});

test('private requests cannot connect to peers and uncertain requests are rejected on disconnect', async () => {
  const peer = new RuntimeClient({ autoLaunch: false, profile: { kind: 'peer' } as never });
  let connected = false;
  (peer as unknown as Internals).ensureConnected = async () => { connected = true; };
  await assert.rejects(peer.localFileRequest('desktop.files.context', {}), /unavailable/);
  assert.equal(connected, false); peer.dispose();

  const client = new RuntimeClient({ autoLaunch: false, controlOnly: true });
  const internal = client as unknown as Internals;
  internal.ensureConnected = async () => {};
  let writes = 0;
  internal.control = { close() {}, write() { writes++; } };
  const request = client.localFileRequest('desktop.files.mutation.complete', { reservationId: 'id', result: {} });
  await Promise.resolve();
  const rejected = assert.rejects(request, /closing/);
  client.dispose(); await rejected;
  assert.equal(writes, 1);
});
