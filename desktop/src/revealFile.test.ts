import assert from 'node:assert/strict';
import test from 'node:test';
import { deletedRevealScope, isWithinScope, revealTarget } from './revealFile.js';

test('reveals only a root-relative runtime result', () => {
  assert.deepEqual(
    revealTarget({ worktreePath: 'ignored-by-helper', path: 'src/file.ts' }, 'C:\\project\\repo'),
    { scope: 'C:\\project\\repo', path: 'C:\\project\\repo\\src\\file.ts' },
  );
});

test('rejects absolute, traversal, and malformed runtime paths', () => {
  for (const path of ['C:\\Windows\\system.ini', '..\\secret.txt', 'src\\..\\..\\secret.txt', '', 'src\0file.ts']) {
    assert.throws(() => revealTarget({ worktreePath: 'C:\\project\\repo', path }, 'C:\\project\\repo'));
  }
});

test('scope checks reject sibling prefixes and accept scope descendants', () => {
  assert.equal(isWithinScope('C:\\project\\repo', 'C:\\project\\repo\\src\\file.ts'), true);
  assert.equal(isWithinScope('C:\\project\\repo', 'C:\\project\\repo-other\\file.ts'), false);
  assert.equal(isWithinScope('C:\\project\\repo', 'C:\\project\\secret.txt'), false);
});

test("uses only the deleted file session's registered worktree or project root", () => {
  const snapshot = { projects: [{ id: 'project-a', path: 'C:\\project\\repo' }], sessions: [
    { id: 'session-a', projectId: 'project-a', worktreePath: 'C:\\project\\repo\\worktree' },
    { id: 'session-b', projectId: 'project-a' },
  ] };
  assert.equal(deletedRevealScope(snapshot, 'session-a'), 'C:\\project\\repo\\worktree');
  assert.equal(deletedRevealScope(snapshot, 'session-b'), 'C:\\project\\repo');
  assert.throws(() => deletedRevealScope(snapshot, 'missing'));
  assert.throws(() => deletedRevealScope({ projects: [], sessions: [{ id: 'session-a', projectId: 'forged' }] }, 'session-a'));
});
