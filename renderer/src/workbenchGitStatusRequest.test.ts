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
