import { describe, expect, it } from 'vitest';
import {
  isWorkspaceEditorProtected,
  MAX_WARM_CLEAN_WORKSPACE_EDITORS,
  selectMountedWorkspaceEditors,
} from './workspaceEditorLifecycle';

describe('workspaceEditorLifecycle', () => {
  it('never unloads dirty or current focused tabs', () => {
    const { mounted, decisions } = selectMountedWorkspaceEditors([
      {
        cardId: 'c1',
        tabId: 'dirty',
        kind: 'file',
        dirty: true,
        current: false,
        focusedCard: false,
      },
      {
        cardId: 'c1',
        tabId: 'current',
        kind: 'file',
        dirty: false,
        current: true,
        focusedCard: true,
      },
      {
        cardId: 'c1',
        tabId: 'cold',
        kind: 'file',
        dirty: false,
        current: false,
        focusedCard: true,
      },
    ], 0);

    expect(mounted.map((m) => m.tabId).sort()).toEqual(['current', 'dirty']);
    expect(decisions.find((d) => d.reason === 'cold-clean')).toBeTruthy();
    expect(isWorkspaceEditorProtected({
      cardId: 'c1',
      tabId: 'dirty',
      kind: 'file',
      dirty: true,
      current: false,
      focusedCard: false,
    })).toBe(true);
  });

  it('keeps only a small warm set of clean inactive editors', () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ({
      cardId: 'c1',
      tabId: `f${i}`,
      kind: 'file' as const,
      dirty: false,
      current: false,
      focusedCard: true,
    }));
    const { mounted } = selectMountedWorkspaceEditors(
      candidates,
      MAX_WARM_CLEAN_WORKSPACE_EDITORS,
    );
    expect(mounted).toHaveLength(MAX_WARM_CLEAN_WORKSPACE_EDITORS);
    expect(mounted.map((m) => m.tabId)).toEqual(['f4', 'f5']);
  });

  it('protects active diff tabs on the focused card', () => {
    const { mounted } = selectMountedWorkspaceEditors([
      {
        cardId: 'c1',
        tabId: 'diff-1',
        kind: 'diff',
        dirty: false,
        current: true,
        focusedCard: true,
      },
      {
        cardId: 'c1',
        tabId: 'file-old',
        kind: 'file',
        dirty: false,
        current: false,
        focusedCard: true,
      },
    ], 0);
    expect(mounted.map((m) => m.tabId)).toEqual(['diff-1']);
  });
});
