import { beforeEach, describe, expect, it } from 'vitest';
import type { AttentionItem } from '../lib/workbench/types';
import {
  DEFAULT_WORKBENCH_RULES,
  normalizeFollowedCardIds,
  normalizeWorkbenchRules,
  useWorkbenchStore,
} from './workbenchStore';
import { useTerminalStore } from './terminalStore';

const reviewItem: AttentionItem = {
  id: 'notification:note-1',
  cardId: 'card-a',
  kind: 'review',
  severity: 'info',
  sourceKind: 'notification',
  sourceId: 'note-1',
  occurredAt: 1_000,
  projectPath: '/repo',
  projectName: 'Repo',
  terminalType: 'shell',
  title: 'Done',
  reasonCode: 'completed_unread',
  capability: {
    openRequest: false,
    openTerminal: true,
    openNotification: true,
    openEvidence: false,
  },
};

beforeEach(() => {
  localStorage.clear();
  useWorkbenchStore.getState().resetRules();
  useWorkbenchStore.setState({
    followedCardIds: [],
    projectOrder: [],
    pinnedProjects: [],
    ignoredAttention: [],
  });
});
describe('workbenchStore', () => {
  it('defaults stalled detection off and preserves the three safe projections', () => {
    expect(useWorkbenchStore.getState().rules).toEqual(DEFAULT_WORKBENCH_RULES);
  });

  it('normalizes persisted values and deduplicates exclusions', () => {
    expect(
      normalizeWorkbenchRules({
        includeWaiting: false,
        includeFailed: 'yes',
        stalledEnabled: true,
        stalledThresholdMinutes: 2,
        stalledExcludedCardIds: ['card-a', '', 'card-a', 42],
      }),
    ).toEqual({
      ...DEFAULT_WORKBENCH_RULES,
      includeWaiting: false,
      stalledEnabled: true,
      stalledThresholdMinutes: 5,
      stalledExcludedCardIds: ['card-a'],
    });
  });

  it('updates rules and toggles card exclusions without runtime projections', () => {
    useWorkbenchStore.getState().updateRules({
      stalledEnabled: true,
      stalledThresholdMinutes: 45,
    });
    useWorkbenchStore.getState().toggleStalledExclusion('card-a');
    useWorkbenchStore.getState().toggleStalledExclusion('card-a');

    expect(useWorkbenchStore.getState().rules).toEqual({
      ...DEFAULT_WORKBENCH_RULES,
      stalledEnabled: true,
      stalledThresholdMinutes: 45,
    });
    const persisted = JSON.parse(localStorage.getItem('threadterm-workbench-store') ?? '{}');
    expect(Object.keys(persisted.state)).toEqual([
      'rules',
      'followedCardIds',
      'projectOrder',
      'pinnedProjects',
      'ignoredAttention',
    ]);
  });

  it('persists ignored attention episodes and drops entries for missing cards', () => {
    useWorkbenchStore.getState().ignoreAttention(reviewItem);
    useWorkbenchStore.getState().ignoreAttention(reviewItem);
    expect(useWorkbenchStore.getState().ignoredAttention).toEqual([
      expect.objectContaining({
        cardId: reviewItem.cardId,
        kind: reviewItem.kind,
        sourceId: reviewItem.sourceId,
      }),
    ]);

    useWorkbenchStore.getState().reconcileIgnoredAttention(['card-live']);
    expect(useWorkbenchStore.getState().ignoredAttention).toEqual([]);
  });

  it('normalizes, prepends and deduplicates followed terminal ids', () => {
    expect(normalizeFollowedCardIds(['card-a', '', 'card-a', 42])).toEqual([
      'card-a',
    ]);

    useWorkbenchStore.getState().followCards(['card-a']);
    useWorkbenchStore.getState().followCards(['card-b', 'card-a', 'card-c']);

    expect(useWorkbenchStore.getState().followedCardIds).toEqual([
      'card-b',
      'card-a',
      'card-c',
    ]);
  });

  it('keeps version-one attention rules while adding empty follow and project orders', async () => {
    localStorage.setItem(
      'threadterm-workbench-store',
      JSON.stringify({
        version: 1,
        state: {
          rules: {
            ...DEFAULT_WORKBENCH_RULES,
            includeWaiting: false,
            stalledThresholdMinutes: 45,
          },
        },
      }),
    );

    await useWorkbenchStore.persist.rehydrate();

    expect(useWorkbenchStore.getState().rules).toMatchObject({
      includeWaiting: false,
      stalledThresholdMinutes: 45,
    });
    expect(useWorkbenchStore.getState().followedCardIds).toEqual([]);
    expect(useWorkbenchStore.getState().projectOrder).toEqual([]);
    expect(useWorkbenchStore.getState().pinnedProjects).toEqual([]);
    expect(useWorkbenchStore.getState().ignoredAttention).toEqual([]);
  });

  it('reconciles project paths without disturbing the retained manual order', () => {
    useWorkbenchStore.setState({
      projectOrder: ['/repo/b', '/repo/stale', '/repo/a'],
    });

    useWorkbenchStore
      .getState()
      .reconcileProjectOrder(['/repo/a', '/repo/b', '/repo/c']);

    expect(useWorkbenchStore.getState().projectOrder).toEqual([
      '/repo/b',
      '/repo/a',
      '/repo/c',
    ]);
  });

  it('moves visible projects while preserving search-hidden project positions', () => {
    useWorkbenchStore.setState({
      projectOrder: ['/repo/a', '/repo/hidden', '/repo/c', '/repo/d'],
    });

    useWorkbenchStore
      .getState()
      .moveProject('/repo/d', '/repo/a', ['/repo/a', '/repo/c', '/repo/d']);

    expect(useWorkbenchStore.getState().projectOrder).toEqual([
      '/repo/d',
      '/repo/hidden',
      '/repo/a',
      '/repo/c',
    ]);
  });

  it('normalizes persisted project order values on rehydrate', async () => {
    localStorage.setItem(
      'threadterm-workbench-store',
      JSON.stringify({
        version: 3,
        state: {
          rules: DEFAULT_WORKBENCH_RULES,
          followedCardIds: [],
          projectOrder: ['/repo/b', '', '/repo/b', 42, '/repo/a'],
        },
      }),
    );

    await useWorkbenchStore.persist.rehydrate();

    expect(useWorkbenchStore.getState().projectOrder).toEqual([
      '/repo/b',
      '/repo/a',
    ]);
  });

  it('unfollows explicitly and prunes only truly missing followed ids', () => {
    useWorkbenchStore
      .getState()
      .followCards(['card-active', 'card-archived', 'card-missing']);
    useWorkbenchStore.getState().unfollowCard('card-active');
    expect(useWorkbenchStore.getState().followedCardIds).toEqual([
      'card-archived',
      'card-missing',
    ]);

    // The model supplies active and archived card ids as valid; only the
    // absent id is pruned by store-level reconciliation.
    useWorkbenchStore
      .getState()
      .reconcileFollowedCards(['card-archived', 'card-live']);
    expect(useWorkbenchStore.getState().followedCardIds).toEqual(['card-archived']);
  });

  it('unfollows explicitly without changing unrelated followed ids', () => {
    useWorkbenchStore.getState().followCards(['card-a', 'card-b', 'card-c']);
    useWorkbenchStore.getState().unfollowCard('card-b');
    expect(useWorkbenchStore.getState().followedCardIds).toEqual([
      'card-a',
      'card-c',
    ]);
  });

  it('pins and unpins projects while enforcing the six-project cap', () => {
    useWorkbenchStore.getState().pinProject('/repo/a');
    useWorkbenchStore.getState().pinProject('/repo/a');
    useWorkbenchStore.getState().pinProject('');
    expect(useWorkbenchStore.getState().pinnedProjects).toEqual(['/repo/a']);

    for (const path of ['/repo/b', '/repo/c', '/repo/d', '/repo/e', '/repo/f']) {
      useWorkbenchStore.getState().pinProject(path);
    }
    expect(useWorkbenchStore.getState().pinnedProjects).toHaveLength(6);

    useWorkbenchStore.getState().pinProject('/repo/g');
    expect(useWorkbenchStore.getState().pinnedProjects).not.toContain('/repo/g');

    useWorkbenchStore.getState().unpinProject('/repo/a');
    expect(useWorkbenchStore.getState().pinnedProjects).toEqual([
      '/repo/b',
      '/repo/c',
      '/repo/d',
      '/repo/e',
      '/repo/f',
    ]);

    useWorkbenchStore.getState().unpinProject('/repo/missing');
    expect(useWorkbenchStore.getState().pinnedProjects).toHaveLength(5);
  });

  it('prunes pinned projects that no longer exist', () => {
    useWorkbenchStore.setState({
      pinnedProjects: ['/repo/a', '/repo/stale', '/repo/b'],
    });

    useWorkbenchStore
      .getState()
      .reconcilePinnedProjects(['/repo/a', '/repo/b', '/repo/c']);

    expect(useWorkbenchStore.getState().pinnedProjects).toEqual([
      '/repo/a',
      '/repo/b',
    ]);
  });

  it('normalizes persisted pinned projects on rehydrate', async () => {
    localStorage.setItem(
      'threadterm-workbench-store',
      JSON.stringify({
        version: 4,
        state: {
          rules: DEFAULT_WORKBENCH_RULES,
          followedCardIds: [],
          projectOrder: [],
          pinnedProjects: [
            '/repo/a',
            '',
            '/repo/a',
            42,
            '/repo/b',
            '/repo/c',
            '/repo/d',
            '/repo/e',
            '/repo/f',
            '/repo/g',
          ],
        },
      }),
    );

    await useWorkbenchStore.persist.rehydrate();

    expect(useWorkbenchStore.getState().pinnedProjects).toEqual([
      '/repo/a',
      '/repo/b',
      '/repo/c',
      '/repo/d',
      '/repo/e',
      '/repo/f',
    ]);
  });

  it('keeps the overlay pin slate independent from Workbench follows', () => {
    useTerminalStore.setState({ pinnedCardIds: ['card-a'] });
    useWorkbenchStore.getState().followCards(['card-a']);
    useWorkbenchStore.getState().unfollowCard('card-a');

    expect(useWorkbenchStore.getState().followedCardIds).toEqual([]);
    expect(useTerminalStore.getState().pinnedCardIds).toEqual(['card-a']);
    useTerminalStore.setState({ pinnedCardIds: [] });
  });
});
