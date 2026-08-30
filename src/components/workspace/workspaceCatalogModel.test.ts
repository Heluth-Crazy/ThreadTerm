import { describe, expect, it } from 'vitest';
import type { TerminalCard } from '../../types/terminal';
import type { WorkspaceTab } from '../../lib/workspace/types';
import { buildWorkspaceCatalog } from './workspaceCatalogModel';

function tab(
  id: string,
  kind: WorkspaceTab['kind'],
  sharedOrder: number,
  relativePath: string | null = null,
): WorkspaceTab {
  return {
    id,
    workspaceId: 'ws-1',
    kind,
    title: relativePath?.split(/[\\/]/).pop() ?? id,
    cardId: kind === 'terminal' ? id.replace('terminal:', '') : null,
    relativePath,
    sharedOrder,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
}

const card = {
  id: 'card-1',
  ptyId: 'card-1',
  projectPath: '/repo',
  projectName: 'Repo shell',
  terminalType: 'shell',
  status: 'running',
  createdAt: 1,
  lastActivity: 1,
  lastOutput: '',
  lastReplyPreview: '',
  messageCount: 0,
  events: [],
  unread: false,
} satisfies TerminalCard;

describe('buildWorkspaceCatalog', () => {
  it('filters Home, keeps fixed categories, and preserves shared order', () => {
    const categories = buildWorkspaceCatalog({
      tabs: [
        tab('file:z', 'file', 5, 'z.ts'),
        tab('home', 'home', 0),
        tab('terminal:card-1', 'terminal', 4),
        tab('file:a', 'file', 2, 'a.ts'),
      ],
      cards: [card],
    });

    expect(categories.map((category) => category.id)).toEqual([
      'sessions',
      'files',
      'changes',
    ]);
    expect(categories[0].rows.map((row) => row.tab.id)).toEqual(['terminal:card-1']);
    expect(categories[1].rows.map((row) => row.tab.id)).toEqual(['file:a', 'file:z']);
    expect(categories[2].rows).toEqual([]);
  });

  it('keeps missing terminal cards and projects dirty/conflict state', () => {
    const categories = buildWorkspaceCatalog({
      tabs: [tab('terminal:gone', 'terminal', 1), tab('diff:a', 'diff', 2, 'a.ts')],
      cards: [],
      dirtyByTabId: { 'diff:a': true },
      conflictByTabId: { 'diff:a': true },
    });

    expect(categories[0].rows[0].card).toBeNull();
    expect(categories[0].rows[0].label).toBe('terminal:gone');
    expect(categories[2].rows[0]).toMatchObject({ dirty: true, conflict: true });
  });

  it('uses the shortest unique parent suffix for duplicate basenames', () => {
    const categories = buildWorkspaceCatalog({
      tabs: [
        tab('file:1', 'file', 1, 'src/client/index.ts'),
        tab('file:2', 'file', 2, 'tests/client/index.ts'),
        tab('file:3', 'file', 3, 'src/server/index.ts'),
      ],
      cards: [],
    });

    expect(categories[1].rows.map((row) => row.parentSuffix)).toEqual([
      'src/client',
      'tests/client',
      'server',
    ]);
  });
});
