import assert from 'node:assert/strict';
import test from 'node:test';
import { sharedGitStatusRequest } from './workbench/gitStatusRequest';

test('concurrent consumers of one worktree share its Git status request', async () => {
  let calls = 0;
  let release!: (value: string) => void;
  const load = () => {
    calls += 1;
    return new Promise<string>(resolve => { release = resolve; });
  };
  const first = sharedGitStatusRequest('project\0tree', load);
  const second = sharedGitStatusRequest('project\0tree', load);
  await Promise.resolve();
  assert.equal(calls, 1);
  release('ready');
  assert.deepEqual(await Promise.all([first, second]), ['ready', 'ready']);
});

test('different worktrees never share a Git status request', async () => {
  let calls = 0;
  const load = async () => ++calls;
  assert.deepEqual(await Promise.all([
    sharedGitStatusRequest('project\0tree-a', load),
    sharedGitStatusRequest('project\0tree-b', load),
  ]), [1, 2]);
});

test('a consumer arriving after the request was sent gets one shared follow-up that starts after it', async () => {
  const releases: Array<(value: string) => void> = [];
  const load = () => new Promise<string>(resolve => { releases.push(resolve); });
  const sent = sharedGitStatusRequest('project\0commit', load);
  await Promise.resolve();
  assert.equal(releases.length, 1);
  // A commit lands here; two surfaces refresh while the first read is still running.
  const late = sharedGitStatusRequest('project\0commit', load);
  const later = sharedGitStatusRequest('project\0commit', load);
  await Promise.resolve();
  assert.equal(releases.length, 1, 'the follow-up waits for the running read');
  releases[0]('before commit');
  assert.equal(await sent, 'before commit');
  for (let turn = 0; turn < 5 && releases.length < 2; turn++) await Promise.resolve();
  assert.equal(releases.length, 2, 'late consumers share one follow-up read');
  releases[1]('after commit');
  assert.deepEqual(await Promise.all([late, later]), ['after commit', 'after commit']);
});

test('a failed read does not block the next consumer', async () => {
  let calls = 0;
  await assert.rejects(sharedGitStatusRequest('project\0failing', async () => { calls++; throw new Error('git failed'); }), /git failed/);
  assert.equal(await sharedGitStatusRequest('project\0failing', async () => { calls++; return 'ok'; }), 'ok');
  assert.equal(calls, 2);
});
