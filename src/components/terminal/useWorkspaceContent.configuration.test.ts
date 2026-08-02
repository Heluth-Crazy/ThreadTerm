import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { localWorkspaceAuthority } from '../../lib/workspace/localAuthority';
import { useWorkspaceSession } from '../workspace/useWorkspaceSession';

const t = ((
  key: string,
  options?: Record<string, unknown>,
) => options?.defaultValue ?? key) as TFunction<'terminal'>;

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    pendingTerminalConfigurations: {},
    focusedCardId: null,
    selectedProjectPath: null,
    selectedWorktreePath: null,
  });
}

describe('useWorkspaceSession terminal configuration reset', () => {
  beforeEach(() => {
    resetStore();
    localWorkspaceAuthority.reset();
  });

  it('keeps file drafts when the terminal directory is reset', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const cards = useTerminalStore.getState().cards;
    const { result } = renderHook(() =>
      useWorkspaceSession({
        cards,
        focusedCardId: id,
        selectedProjectPath: '/repo',
        selectedWorktreePath: null,
        t,
      }),
    );

    await waitFor(() => expect(result.current.selectedWorkspaceId).toBeTruthy());
    await act(async () => {
      await result.current.openWorkspaceFile('/repo', {
        name: 'app.ts',
        path: '/repo/app.ts',
        isDir: false,
        isHidden: false,
      });
    });
    const tabId = result.current.tabs.find((tab) => tab.kind === 'file')?.id ?? '';
    act(() => result.current.markWorkspaceTabDirty(result.current.selectedWorkspaceId!, tabId, true));

    let allowed = false;
    await act(async () => {
      allowed = await result.current.requestCardWorkspaceReset(id);
    });

    expect(allowed).toBe(true);
    // File draft/tab remains for the worktree; only the terminal tab is dropped.
    expect(result.current.tabs.some((tab) => tab.id === tabId)).toBe(true);
    expect(result.current.tabs.some((tab) => tab.kind === 'terminal')).toBe(false);
  });

  it('allows directory change without discarding shared dirty drafts', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const cards = useTerminalStore.getState().cards;
    const { result } = renderHook(() =>
      useWorkspaceSession({
        cards,
        focusedCardId: id,
        selectedProjectPath: '/repo',
        selectedWorktreePath: null,
        t,
      }),
    );

    await waitFor(() => expect(result.current.selectedWorkspaceId).toBeTruthy());
    await act(async () => {
      await result.current.openWorkspaceFile('/repo', {
        name: 'app.ts',
        path: '/repo/app.ts',
        isDir: false,
        isHidden: false,
      });
    });
    const tabId = result.current.tabs.find((tab) => tab.kind === 'file')?.id ?? '';
    act(() => result.current.markWorkspaceTabDirty(result.current.selectedWorkspaceId!, tabId, true));

    let allowed = false;
    await act(async () => {
      allowed = await result.current.requestCardWorkspaceReset(id);
    });

    expect(allowed).toBe(true);
    expect(result.current.dirtyByTabId[tabId]).toBe(true);
  });
});
