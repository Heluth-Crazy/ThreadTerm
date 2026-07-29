import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_RULES,
  normalizeFollowedCardIds,
  normalizeWorkbenchRules,
  useWorkbenchStore,
} from './workbenchStore';
import { useTerminalStore } from './terminalStore';

beforeEach(() => {
  localStorage.clear();
  useWorkbenchStore.getState().resetRules();
  useWorkbenchStore.setState({ followedCardIds: [] });
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
    expect(Object.keys(persisted.state)).toEqual(['rules', 'followedCardIds']);
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

  it('keeps version-one attention rules while adding an empty follow list', async () => {
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
  });

  it('unfollows explicitly and removes only ids missing from the active card set', () => {
    useWorkbenchStore.getState().followCards(['card-a', 'card-b', 'card-c']);
    useWorkbenchStore.getState().unfollowCard('card-b');
    expect(useWorkbenchStore.getState().followedCardIds).toEqual([
      'card-a',
      'card-c',
    ]);

    useWorkbenchStore.getState().reconcileFollowedCards(['card-c', 'card-live']);
    expect(useWorkbenchStore.getState().followedCardIds).toEqual(['card-c']);
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
