import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeClient } from '../src/runtime-client.js';

type Internals = {
  ensureConnected(): Promise<void>;
  control?: { write(payload: Buffer): void; close(): void };
  handleControlFrame(frame: Buffer): void;
};

test('backup requests outlive the ordinary request timeout while unrelated requests still expire', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new RuntimeClient({ autoLaunch: false });
  const internal = client as unknown as Internals;
  const requests: Array<{ id: string; method: string }> = [];
  internal.ensureConnected = async () => undefined;
  internal.control = {
    write(payload) { requests.push(JSON.parse(payload.toString('utf8')) as { id: string; method: string }); },
    close() {},
  };
  try {
    const backup = client.request('data.backup', { targetPath: 'backup.sqlite3', operationId: 'backup-operation' });
    const verify = client.request('data.backup.verify', { path: 'backup.sqlite3' });
    const ordinary = client.request('runtime.health', {});
    await Promise.resolve();
    assert.deepEqual(requests.map(request => request.method), ['data.backup', 'data.backup.verify', 'runtime.health']);

    let backupSettled = false;
    void backup.then(() => { backupSettled = true; });
    context.mock.timers.tick(31_000);
    await Promise.resolve();
    assert.equal(backupSettled, false, 'backup remains pending after the ordinary timeout');
    await assert.rejects(ordinary, /Runtime request runtime\.health timed out/);

    const verification = { verified: true, files: 2, sizeBytes: 42, checkedAt: '2026-10-25T00:00:00Z' };
    internal.handleControlFrame(Buffer.from(JSON.stringify({ v: 1, id: requests[0].id, result: { path: 'backup.sqlite3', sizeBytes: 42, format: 'threadterm-backup-sqlite3', verification } })));
    internal.handleControlFrame(Buffer.from(JSON.stringify({ v: 1, id: requests[1].id, result: verification })));
    assert.deepEqual(await backup, { path: 'backup.sqlite3', sizeBytes: 42, format: 'threadterm-backup-sqlite3', verification });
    assert.deepEqual(await verify, verification);
  } finally {
    client.dispose();
    context.mock.timers.reset();
  }
});
