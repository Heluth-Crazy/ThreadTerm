import { describe, expect, it } from 'vitest';
import type { TerminalCard } from '../../types/terminal';
import type { AttentionItem } from './types';
import {
  deriveFollowedCards,
  deriveProjectWorkbenchOverviews,
  deriveWorkbenchScopeAttentionCounts,
  getWorkbenchProjectAttentionCount,
  getWorkbenchWorktreeAttentionCount,
  workbenchProjectScopeKey,
  workbenchWorktreeScopeKey,
} from './deriveFollowedTerminals';

function card(
  id: string,
  overrides: Partial<TerminalCard> = {},
): TerminalCard {
  return {
    id,
    ptyId: id,
    projectPath: '/repo/b',
    projectName: 'Beta',
    terminalType: 'codex',
    status: 'running',
    createdAt: 1,
    lastActivity: 1,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    ...overrides,
  };
}

function attention(
  id: string,
  cardId: string,
  overrides: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    id,
    cardId,
    kind: 'waiting_input',
    severity: 'warning',
    sourceKind: 'terminal_state',
    sourceId: cardId,
    occurredAt: 1,
    projectPath: '/repo/b',
    projectName: 'Beta',
    terminalType: 'codex',
    title: 'Waiting',
    reasonCode: 'waiting_state',
    capability: {
      openRequest: false,
      openTerminal: true,
      openNotification: false,
      openEvidence: false,
    },
    ...overrides,
  };
}

describe('followed terminal derivation', () => {
  it('keeps explicit follow order and applies project/worktree scope without reordering', () => {
    const cards = [
      card('main'),
      card('feature', {
        worktreePath: '/repo/b-feature',
        branchLabel: 'feature',
      }),
      card('alpha', {
        projectPath: '/repo/a',
        projectName: 'Alpha',
      }),
    ];

    expect(
      deriveFollowedCards(cards, ['feature', 'alpha', 'main']).map(({ id }) => id),
    ).toEqual(['feature', 'alpha', 'main']);
    expect(
      deriveFollowedCards(
        cards,
        ['feature', 'alpha', 'main'],
        '/repo/b',
        '/repo/b-feature',
      ).map(({ id }) => id),
    ).toEqual(['feature']);
  });

  it('builds stable alphabetical project overviews from active cards', () => {
    const cards = [
      card('beta-running'),
      card('alpha-failed', {
        projectPath: '/repo/a',
        projectName: 'alpha',
        status: 'failed',
      }),
      card('beta-review', { status: 'completed' }),
    ];
    const items = [
      attention('beta-waiting', 'beta-running'),
      attention('alpha-failure', 'alpha-failed', {
        kind: 'failed',
        projectPath: '/repo/a',
        projectName: 'alpha',
        reasonCode: 'failed_state',
      }),
      attention('beta-review', 'beta-review', {
        kind: 'review',
        reasonCode: 'completed_unread',
      }),
    ];

    expect(
      deriveProjectWorkbenchOverviews(
        cards,
        items,
        ['beta-review', 'alpha-failed'],
      ),
    ).toEqual([
      {
        projectPath: '/repo/a',
        projectName: 'alpha',
        followedCount: 1,
        runningCount: 0,
        attentionCount: 1,
        reviewCount: 0,
        failedCount: 1,
      },
      {
        projectPath: '/repo/b',
        projectName: 'Beta',
        followedCount: 1,
        runningCount: 1,
        attentionCount: 2,
        reviewCount: 1,
        failedCount: 0,
      },
    ]);
  });

  it('counts attention independently for project and worktree rows', () => {
    const counts = deriveWorkbenchScopeAttentionCounts([
      attention('main', 'main'),
      attention('feature', 'feature', {
        worktreePath: 'C:\\Repo\\B-Feature',
      }),
    ]);

    expect(counts.byProjectPath[workbenchProjectScopeKey('/repo/b')]).toBe(2);
    expect(
      counts.byWorktreeKey[
        workbenchWorktreeScopeKey('/repo/b', 'c:/repo/b-feature')
      ],
    ).toBe(1);
    expect(getWorkbenchProjectAttentionCount(counts, '/repo/b')).toBe(2);
    expect(getWorkbenchProjectAttentionCount(counts, '/REPO/B')).toBe(0);
    expect(
      getWorkbenchWorktreeAttentionCount(
        counts,
        '/repo/b',
        'c:/repo/b-feature',
      ),
    ).toBe(1);
    expect(
      getWorkbenchWorktreeAttentionCount(counts, '/repo/b', '/repo/missing'),
    ).toBe(0);
  });
});
