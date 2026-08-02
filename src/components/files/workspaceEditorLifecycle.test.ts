import { describe, expect, it } from 'vitest';
import {
  isWorkspaceEditorProtected,
  MAX_WARM_CLEAN_WORKSPACE_EDITORS,
  selectMountedWorkspaceEditors,
} from './workspaceEditorLifecycle';

describe('workspaceEditorLifecycle', () => {
  it('never unloads dirty or current selected-workspace tabs', () => {
    const { mounted, decisions } = selectMountedWorkspaceEditors([
      {
        workspaceId: 'ws1',
        tabId: 'dirty',
        kind: 'file',
        dirty: true,
        current: false,
        selectedWorkspace: false,
      },
      {
        workspaceId: 'ws1',
        tabId: 'current',
        kind: 'file',
        dirty: false,
        current: true,
        selectedWorkspace: true,
      },
      {
        workspaceId: 'ws1',
        tabId: 'cold',
        kind: 'file',
        dirty: false,
        current: false,
        selectedWorkspace: true,
      },
    ], 0);

    expect(mounted.map((m) => m.tabId).sort()).toEqual(['current', 'dirty']);
    expect(decisions.find((d) => d.reason === 'cold-clean')).toBeTruthy();
    expect(isWorkspaceEditorProtected({
      workspaceId: 'ws1',
      tabId: 'dirty',
      kind: 'file',
      dirty: true,
      current: false,
      selectedWorkspace: false,
    })).toBe(true);
  });

  it('keeps only a small warm set of clean inactive editors', () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ({
      workspaceId: 'ws1',
      tabId: `f${i}`,
      kind: 'file' as const,
      dirty: false,
      current: false,
      selectedWorkspace: true,
    }));
    const { mounted } = selectMountedWorkspaceEditors(
      candidates,
      MAX_WARM_CLEAN_WORKSPACE_EDITORS,
    );
    expect(mounted).toHaveLength(MAX_WARM_CLEAN_WORKSPACE_EDITORS);
    expect(mounted.map((m) => m.tabId)).toEqual(['f4', 'f5']);
  });

  it('protects active diff tabs on the selected workspace', () => {
    const { mounted } = selectMountedWorkspaceEditors([
      {
        workspaceId: 'ws1',
        tabId: 'diff-1',
        kind: 'diff',
        dirty: false,
        current: true,
        selectedWorkspace: true,
      },
      {
        workspaceId: 'ws1',
        tabId: 'file-old',
        kind: 'file',
        dirty: false,
        current: false,
        selectedWorkspace: true,
      },
    ], 0);
    expect(mounted.map((m) => m.tabId)).toEqual(['diff-1']);
  });

  it('isolates clean editors from non-selected workspaces', () => {
    const { mounted } = selectMountedWorkspaceEditors([
      {
        workspaceId: 'ws-a',
        tabId: 'file-a',
        kind: 'file',
        dirty: false,
        current: true,
        selectedWorkspace: true,
      },
      {
        workspaceId: 'ws-b',
        tabId: 'file-b',
        kind: 'file',
        dirty: false,
        current: true,
        selectedWorkspace: false,
      },
    ], 2);
    expect(mounted.map((m) => m.tabId)).toEqual(['file-a']);
  });
});
