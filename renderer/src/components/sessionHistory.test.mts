import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSessionHistory, nextSelection } from './sessionHistory.js';

const sessions = [
  { id: 'live', title: 'Checkout', provider: 'codex', mode: 'terminal', status: 'running', createdAt: '2026-09-01', updatedAt: '2026-09-03', projectId: 'p', worktreePath: 'C:/repo/main' },
  { id: 'marked', title: 'Review', provider: 'claude', mode: 'chat', status: 'exited', createdAt: '2026-09-01', updatedAt: '2026-09-02', projectId: 'p', worktreePath: 'C:/repo/review', bookmarked: true },
  { id: 'archived', title: 'Old fix', provider: 'shell', mode: 'terminal', status: 'exited', createdAt: '2026-09-01', updatedAt: '2026-09-04', projectId: 'q', archived: true },
] as const;

test('history filters independently combine project, worktree, status, and query', () => {
  assert.deepEqual(filterSessionHistory(sessions, 'checkout', 'all', 'p', 'C:/repo/main', 'running').map(item => item.id), ['live']);
  assert.deepEqual(filterSessionHistory(sessions, '', 'bookmarked', '', '', '').map(item => item.id), ['marked']);
  assert.deepEqual(filterSessionHistory(sessions, '', 'archived', '', '', '').map(item => item.id), ['archived']);
});

test('history selection changes only the requested identity', () => {
  const selected = nextSelection(new Set(['live']), 'marked');
  assert.deepEqual([...selected].sort(), ['live', 'marked']);
  assert.deepEqual([...nextSelection(selected, 'live')], ['marked']);
});
