import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_RULES,
  normalizeWorkbenchRules,
  useWorkbenchStore,
} from './workbenchStore';

beforeEach(() => {
  localStorage.clear();
  useWorkbenchStore.getState().resetRules();
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
    expect(Object.keys(persisted.state)).toEqual(['rules']);
  });
});
