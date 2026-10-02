import assert from 'node:assert/strict';
import test from 'node:test';
import { branchSync, changeNote, listedChanges, summarizeChanges } from '../renderer/src/branchGit.ts';

const change = (path, indexStatus, worktreeStatus, untracked = false) => ({ path, indexStatus, worktreeStatus, untracked });

test('branch sync: detached, unpublished, synced and diverged', () => {
  assert.deepEqual(branchSync({ branch: null, upstream: null, ahead: 0, behind: 0 }), { kind: 'detached' });
  assert.deepEqual(branchSync({ branch: 'feature/a', upstream: null, ahead: 3, behind: 0 }), { kind: 'unpublished' });
  assert.deepEqual(branchSync({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 }), { kind: 'synced', upstream: 'origin/main' });
  assert.deepEqual(branchSync({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 }), { kind: 'diverged', upstream: 'origin/main', ahead: 2, behind: 1 });
});

test('change summary counts each file once and names staged, untracked and conflicts', () => {
  const changes = [change('a.ts', 'M', ' '), change('b.ts', 'M', 'M'), change('c.ts', ' ', 'M'), change('new.txt', '?', '?', true), change('both.ts', 'U', 'U')];
  const summary = summarizeChanges(changes);
  assert.deepEqual(summary, { total: 5, staged: 2, untracked: 1, conflicts: 1 });
  assert.equal(changeNote(summary, false), '1 conflict · 2 staged · 1 untracked');
  assert.equal(changeNote(summary, true), '1 个冲突 · 2 个已暂存 · 1 个未跟踪');
  assert.equal(changeNote(summarizeChanges([change('c.ts', ' ', 'M')]), false), '');
  assert.deepEqual(summarizeChanges([]), { total: 0, staged: 0, untracked: 0, conflicts: 0 });
});

test('listed changes: conflicts first, untracked last, Git order within groups, capped', () => {
  const changes = [change('new.txt', '?', '?', true), change('src/b.ts', ' ', 'M'), change('both.ts', 'U', 'U'), change('src/a.ts', 'M', ' '), change('gone.ts', ' ', 'D')];
  const listed = listedChanges(changes, 4);
  assert.deepEqual(listed.map(item => item.change.path), ['both.ts', 'src/b.ts', 'src/a.ts', 'gone.ts']);
  assert.deepEqual(listed.map(item => item.decoration), [{ letter: '!', tone: 'conflict' }, { letter: 'M', tone: 'modified' }, { letter: 'M', tone: 'modified' }, { letter: 'D', tone: 'deleted' }]);
  assert.deepEqual(listed.map(item => item.stagedOnly), [false, false, true, false], 'only an index-only change opens the staged diff');
  assert.deepEqual(listed.map(item => item.partlyStaged), [false, false, false, false]);
  assert.deepEqual(listedChanges([change('mixed.ts', 'M', 'M')], 1).map(({ stagedOnly, partlyStaged }) => [stagedOnly, partlyStaged]), [[false, true]], 'staged content plus further edits');
  assert.equal(listedChanges(changes, 0).length, 0);
  assert.equal(listedChanges(changes, 10).at(-1).change.path, 'new.txt');
});
