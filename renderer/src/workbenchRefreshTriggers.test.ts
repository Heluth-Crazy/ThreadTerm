import assert from 'node:assert/strict';
import test from 'node:test';
import { eventTouchesWorktree } from './workbench/refreshTriggers';

const scope = { projectId: 'p1', worktreePath: 'C:/work/tree' };
const rootScope = { projectId: 'p1' };
const sessions = new Set(['s1', 's2']);

test('a scoped git event refreshes only that worktree', () => {
  const event = { event: 'state.changed', data: { kind: 'git', projectId: 'p1', worktreePath: 'C:/work/tree' } };
  assert.equal(eventTouchesWorktree(event, scope, sessions), true);
  assert.equal(eventTouchesWorktree(event, { ...scope, worktreePath: 'C:/work/other' }, sessions), false);
  assert.equal(eventTouchesWorktree(event, { projectId: 'p2', worktreePath: 'C:/work/tree' }, sessions), false);
  assert.equal(eventTouchesWorktree(event, rootScope, sessions), false, 'a worktree event is not the project root');
});

test('a project-root git event matches a scope without a worktree path', () => {
  const event = { event: 'state.changed', data: { kind: 'git', projectId: 'p1', worktreePath: null } };
  assert.equal(eventTouchesWorktree(event, rootScope, sessions), true);
  assert.equal(eventTouchesWorktree(event, scope, sessions), false);
});

test('a finished agent turn refreshes the sessions of the scope', () => {
  for (const kind of ['chat.turn.completed', 'chat.error'])
    assert.equal(eventTouchesWorktree({ event: 'state.changed', data: { kind, sessionId: 's1' } }, scope, sessions), true);
  assert.equal(eventTouchesWorktree({ event: 'state.changed', data: { kind: 'chat.turn.completed', sessionId: 's9' } }, scope, sessions), false);
});

test('a running turn, an unrelated event and a malformed payload are ignored', () => {
  assert.equal(eventTouchesWorktree({ event: 'state.changed', data: { kind: 'chat.turn.started', sessionId: 's1' } }, scope, sessions), false);
  assert.equal(eventTouchesWorktree({ event: 'state.changed', data: { kind: 'session.title', sessionId: 's1' } }, scope, sessions), false);
  assert.equal(eventTouchesWorktree({ event: 'state.changed', data: {} }, scope, sessions), false);
  assert.equal(eventTouchesWorktree({ event: 'state.changed' }, scope, sessions), false);
  assert.equal(eventTouchesWorktree({ event: 'chat.item', data: { kind: 'git', projectId: 'p1' } }, rootScope, sessions), false);
});

test('a session status that ends an agent or terminal run refreshes its scope', () => {
  for (const status of ['idle', 'exited', 'interrupted', 'error'])
    assert.equal(eventTouchesWorktree({ event: 'session.status', data: { sessionId: 's2', status } }, scope, sessions), true);
  for (const status of ['running', 'starting', 'waiting'])
    assert.equal(eventTouchesWorktree({ event: 'session.status', data: { sessionId: 's2', status } }, scope, sessions), false);
  assert.equal(eventTouchesWorktree({ event: 'session.status', data: { sessionId: 'foreign', status: 'exited' } }, scope, sessions), false);
});
