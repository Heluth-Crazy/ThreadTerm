import { describe, it, expect } from 'vitest';
import { groupCardsByProject } from './useProjectGroups';
import type { TerminalCard } from '../../types/terminal';

function mkCard(overrides: Partial<TerminalCard> = {}): TerminalCard {
  const now = Date.now();
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    ptyId: overrides.id ?? 'pty',
    projectName: overrides.projectName ?? 'demo',
    projectPath: overrides.projectPath ?? '/tmp/demo',
    worktreePath: undefined,
    terminalType: 'shell',
    command: undefined,
    status: overrides.status ?? 'idle',
    createdAt: now,
    lastActivity: overrides.lastActivity ?? now,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: overrides.unread ?? false,
    ...overrides,
  } as TerminalCard;
}

describe('groupCardsByProject', () => {
  it('groups by projectPath and counts unread', () => {
    const groups = groupCardsByProject([
      mkCard({ projectPath: '/a', projectName: 'a', unread: true, lastActivity: 100 }),
      mkCard({ projectPath: '/a', projectName: 'a', unread: false, lastActivity: 200 }),
      mkCard({ projectPath: '/b', projectName: 'b', unread: false, lastActivity: 150 }),
    ]);
    // Group /a has one unread and lastActivity=200 → it sorts before /b
    expect(groups.map((g) => g.path)).toEqual(['/a', '/b']);
    const a = groups.find((g) => g.path === '/a')!;
    expect(a.cards).toHaveLength(2);
    expect(a.unreadCount).toBe(1);
    expect(a.lastActivity).toBe(200);
  });

  it('sorts projects with unread first', () => {
    const groups = groupCardsByProject([
      mkCard({ projectPath: '/a', unread: false, lastActivity: 1000 }),
      mkCard({ projectPath: '/b', unread: true, lastActivity: 500 }),
    ]);
    // /b has unread so it outranks /a despite older activity
    expect(groups[0].path).toBe('/b');
  });

  it('collects distinct statuses per group', () => {
    const groups = groupCardsByProject([
      mkCard({ projectPath: '/a', status: 'running' }),
      mkCard({ projectPath: '/a', status: 'waiting' }),
      mkCard({ projectPath: '/a', status: 'running' }),
    ]);
    const a = groups[0];
    expect(Array.from(a.statuses).sort()).toEqual(['running', 'waiting']);
  });
});
