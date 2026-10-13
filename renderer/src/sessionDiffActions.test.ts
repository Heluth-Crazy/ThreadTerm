import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionDiffActions } from './sessionDiffActions';

test('each tab checks and opens diffs against its own session root', () => {
  const opened: unknown[] = [];
  const first = sessionDiffActions({ id: 'first', projectId: 'p', worktreePath: 'D:\\first' }, 'D:\\project', value => opened.push(value));
  const second = sessionDiffActions({ id: 'second', projectId: 'p', worktreePath: 'D:\\second' }, 'D:\\project', value => opened.push(value));
  assert.equal(first.canOpenDiff?.('D:\\second\\file.ts'), false);
  assert.equal(second.canOpenDiff?.('D:\\second\\file.ts'), true);
  first.openDiff?.('D:\\other\\file.ts');
  first.openDiff?.('D:\\second\\file.ts');
  second.openDiff?.('src/file.ts');
  assert.deepEqual(opened, [{ projectId: 'p', worktreePath: 'D:\\second', path: 'src/file.ts', kind: 'diff', ownerSessionId: 'second' }]);
});

test('project-root fallback and unavailable diff hosts preserve permissions', () => {
  const session = { id: 's', projectId: 'p' };
  const actions = sessionDiffActions(session, 'D:\\project', () => {});
  assert.equal(actions.canOpenDiff?.('D:\\project\\file.ts'), true);
  assert.equal(actions.canOpenDiff?.('D:\\other\\file.ts'), false);
  assert.deepEqual(sessionDiffActions(session, 'D:\\project', undefined), {});
  assert.deepEqual(sessionDiffActions(undefined, 'D:\\project', () => {}), {});
});
