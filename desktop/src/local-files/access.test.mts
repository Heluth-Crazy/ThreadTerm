import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalFileAccess } from './access.ts';
import { LocalFileAccessNotCreatedError } from './coordination.ts';

test('access stays leased until the whole Node operation settles', async () => {
  let finish!: () => void;
  const work = new Promise<void>(done => { finish = done; });
  const calls: string[] = [];
  const access = new LocalFileAccess(async (method, params) => {
    calls.push(method);
    return method.endsWith('.begin') ? { accessId: params.accessId } : null;
  });
  const reading = access.run(async () => { await work; return 'bytes'; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['desktop.files.access.begin']);
  finish(); assert.equal(await reading, 'bytes');
  assert.deepEqual(calls, ['desktop.files.access.begin', 'desktop.files.access.release']);
});

test('lost begin reply releases the known id without starting file I/O', async () => {
  let began: unknown, released: unknown, ran = false;
  const access = new LocalFileAccess(async (method, params) => {
    if (method.endsWith('.begin')) { began = params.accessId; throw new Error('lost begin response'); }
    released = params.accessId; return null;
  });
  await assert.rejects(access.run(async () => { ran = true; }), /lost begin response/);
  assert.equal(ran, false);
  assert.equal(typeof began, 'string');
  assert.equal(released, began);
});

test('failed releases are retried idempotently before later I/O without replaying effects', async () => {
  const calls: { method: string; id: unknown }[] = [];
  let failRelease = true, effects = 0;
  const access = new LocalFileAccess(async (method, params) => {
    calls.push({ method, id: params.accessId });
    if (method.endsWith('.begin')) return { accessId: params.accessId };
    if (failRelease) throw new Error('disconnected');
    return null;
  });
  assert.equal(await access.run(async () => { effects += 1; return 'saved'; }), 'saved');
  await assert.rejects(access.run(async () => { effects += 1; }), /disconnected/);
  assert.equal(effects, 1);
  failRelease = false;
  await access.flush();
  assert.deepEqual(calls.map(call => call.method), ['desktop.files.access.begin', 'desktop.files.access.release', 'desktop.files.access.release', 'desktop.files.access.release']);
  assert.ok(calls.every(call => call.id === calls[0].id));
  await access.run(async () => { effects += 1; });
  assert.equal(effects, 2);
});

test('release errors do not replace an uncertain filesystem failure', async () => {
  const access = new LocalFileAccess(async (method, params) => {
    if (method.endsWith('.begin')) return { accessId: params.accessId };
    throw new Error('release lost');
  });
  await assert.rejects(access.run(async () => { throw new Error('save outcome unknown'); }), /save outcome unknown/);
  await assert.rejects(access.flush(), /release lost/);
});

test('an action error cannot suppress cleanup for an already accepted access', async () => {
  let releases = 0;
  const access = new LocalFileAccess(async (method, params) => {
    if (method.endsWith('.begin')) return {accessId:params.accessId};
    releases++; return null;
  });
  await assert.rejects(access.run(async () => { throw new LocalFileAccessNotCreatedError('another request failed'); }), /another request failed/);
  assert.equal(releases, 1);
  await access.flush();
  assert.equal(releases, 1);
});
