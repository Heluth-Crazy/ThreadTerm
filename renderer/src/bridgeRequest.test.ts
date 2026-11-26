import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from './bridge';
import { currentNotices, TRANSPORT_NOTICE } from './notices';

type Stub = (method: string, params: unknown) => Promise<unknown>;
const install = (stub: Stub) => { (globalThis as { window?: unknown }).window = { threadterm: { request: stub } }; };
const ipc = (text: string) => new Error(`Error invoking remote method 'threadterm:request': ${text}`);

test('a read sent while the connection dropped is sent again; an action is not', async () => {
  let calls = 0;
  install(async method => { calls++; if (calls === 1) throw ipc('RuntimeUnavailableError: Runtime pipe closed'); return { method }; });
  assert.deepEqual(await request('worktree.list', { projectId: 'p' }), { method: 'worktree.list' });
  assert.equal(calls, 2);

  calls = 0;
  install(async () => { calls++; throw ipc('RuntimeUnavailableError: Runtime pipe closed'); });
  await assert.rejects(request('settings.update', { patch: {}, expectedRevision: 1, operationId: 'x' }), /Lost the connection/);
  assert.equal(calls, 1, 'an action is never repeated by the bridge');
});

test('a read the runtime did not answer waits instead of failing: the notice shows meanwhile and the answer clears it', async () => {
  let calls = 0, noticeWhileWaiting = false;
  install(async () => {
    calls++;
    if (calls === 1) throw ipc('RuntimeUnavailableError: Runtime request worktree.list timed out');
    noticeWhileWaiting = currentNotices().some(row => row.key === TRANSPORT_NOTICE);
    return [{ id: 'main' }];
  });
  assert.deepEqual(await request('worktree.list', { projectId: 'p' }), [{ id: 'main' }], 'the view gets its data, never the timeout');
  assert.equal(calls, 2);
  assert.equal(noticeWhileWaiting, true, 'the app-wide notice says the runtime is slow while the read waits');
  assert.equal(currentNotices().some(row => row.key === TRANSPORT_NOTICE), false, 'the answer clears it');
});

test('an action that timed out fails at once and says it may still be running', async () => {
  let calls = 0;
  install(async () => { calls++; throw ipc('RuntimeUnavailableError: Runtime request git.push timed out'); });
  await assert.rejects(request('git.push', { projectId: 'p', operationId: 'x' } as never), error =>
    (error as { code?: string }).code === 'runtime_timeout' && /may still be running/.test((error as Error).message));
  assert.equal(calls, 1);
});
