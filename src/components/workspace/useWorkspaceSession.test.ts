import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { localWorkspaceAuthority } from '../../lib/workspace/localAuthority';
import { HOME_TAB_ID } from '../../lib/workspace/types';
import { useWorkspaceSession } from './useWorkspaceSession';

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

describe('useWorkspaceSession worktree isolation', () => {
  beforeEach(() => {
    resetStore();
    localWorkspaceAuthority.reset();
  });

  it('shares file tabs across terminals in the same worktree', async () => {
    const a = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const b = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const cards = useTerminalStore.getState().cards;

    const { result, rerender } = renderHook(
      ({ focusedCardId }: { focusedCardId: string | null }) =>
        useWorkspaceSession({
          cards,
          focusedCardId,
          selectedProjectPath: '/repo',
          selectedWorktreePath: null,
          t,
        }),
      { initialProps: { focusedCardId: a } },
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

    expect(result.current.tabs.some((tab) => tab.kind === 'file')).toBe(true);
    const fileTabId = result.current.tabs.find((tab) => tab.kind === 'file')?.id;

    rerender({ focusedCardId: b });
    await waitFor(() =>
      expect(result.current.tabs.some((tab) => tab.id === fileTabId)).toBe(true),
    );
  });

  it('isolates tabs between different worktrees', async () => {
    const a = useTerminalStore.getState().createCard({
      projectName: 'repo-a',
      projectPath: '/repo-a',
      terminalType: 'shell',
    });
    useTerminalStore.getState().createCard({
      projectName: 'repo-b',
      projectPath: '/repo-b',
      terminalType: 'shell',
    });
    const cards = useTerminalStore.getState().cards;

    const { result, rerender } = renderHook(
      ({
        focusedCardId,
        project,
      }: {
        focusedCardId: string | null;
        project: string;
      }) =>
        useWorkspaceSession({
          cards,
          focusedCardId,
          selectedProjectPath: project,
          selectedWorktreePath: null,
          t,
        }),
      { initialProps: { focusedCardId: a, project: '/repo-a' } },
    );

    await waitFor(() => expect(result.current.selectedWorkspaceId).toBeTruthy());
    await act(async () => {
      await result.current.openWorkspaceFile('/repo-a', {
        name: 'a.ts',
        path: '/repo-a/a.ts',
        isDir: false,
        isHidden: false,
      });
    });
    const wsA = result.current.selectedWorkspaceId;
    expect(result.current.tabs.some((tab) => tab.relativePath === 'a.ts')).toBe(true);

    const cardB = cards.find((card) => card.projectPath === '/repo-b')!;
    rerender({ focusedCardId: cardB.id, project: '/repo-b' });
    await waitFor(() =>
      expect(result.current.selectedWorkspaceId).not.toBe(wsA),
    );
    expect(
      result.current.tabs.every(
        (tab) => tab.kind !== 'file' || tab.relativePath !== 'a.ts',
      ),
    ).toBe(true);
  });

  it('enters home without a terminal when worktree is selected', async () => {
    const { result } = renderHook(() =>
      useWorkspaceSession({
        cards: [],
        focusedCardId: null,
        selectedProjectPath: '/empty-repo',
        selectedWorktreePath: '/empty-repo',
        t,
      }),
    );

    await waitFor(() => expect(result.current.selectedWorkspaceId).toBeTruthy());
    expect(result.current.homeActive).toBe(true);
    expect(result.current.activeTabId).toBe(HOME_TAB_ID);
    expect(result.current.workspaceShellOpen).toBe(true);
  });

  it('closes terminal tab only without ending the card', async () => {
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

    await waitFor(() =>
      expect(result.current.tabs.some((tab) => tab.kind === 'terminal')).toBe(true),
    );
    const tabId = result.current.tabs.find((tab) => tab.kind === 'terminal')!.id;

    await act(async () => {
      await result.current.closeWorkspaceTab(tabId);
    });
    expect(result.current.terminalCloseRequest).toBeTruthy();

    await act(async () => {
      await result.current.resolveTerminalClose('closeTabOnly');
    });

    expect(result.current.tabs.some((tab) => tab.id === tabId)).toBe(false);
    expect(useTerminalStore.getState().cards.some((card) => card.id === id)).toBe(true);
  });

  it('ends terminal when close-and-end is chosen', async () => {
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

    await waitFor(() =>
      expect(result.current.tabs.some((tab) => tab.kind === 'terminal')).toBe(true),
    );
    const tabId = result.current.tabs.find((tab) => tab.kind === 'terminal')!.id;

    await act(async () => {
      await result.current.closeWorkspaceTab(tabId);
    });
    expect(result.current.terminalCloseRequest).toBeTruthy();

    await act(async () => {
      await result.current.resolveTerminalClose('closeAndEnd');
    });

    expect(useTerminalStore.getState().cards.some((card) => card.id === id)).toBe(false);
  });

  it('keeps file drafts when archiving a terminal', async () => {
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
    const fileTabId = result.current.tabs.find((tab) => tab.kind === 'file')!.id;
    act(() => {
      result.current.markWorkspaceTabDirty(result.current.selectedWorkspaceId!, fileTabId, true);
    });

    await act(async () => {
      await result.current.requestArchiveCard(id);
    });

    expect(useTerminalStore.getState().cards.some((card) => card.id === id)).toBe(false);
    await act(async () => {
      await result.current.selectWorkspaceByRoot('/repo');
    });
    expect(result.current.tabs.some((tab) => tab.id === fileTabId)).toBe(true);
  });

  it('does not migrate tabs on directory reset; only drops terminal tab', async () => {
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
    const fileTabId = result.current.tabs.find((tab) => tab.kind === 'file')!.id;

    let allowed = false;
    await act(async () => {
      allowed = await result.current.requestCardWorkspaceReset(id);
    });
    expect(allowed).toBe(true);
    expect(result.current.tabs.some((tab) => tab.kind === 'terminal')).toBe(false);
    expect(result.current.tabs.some((tab) => tab.id === fileTabId)).toBe(true);
  });

  it('closes dirty file tabs only after discard decision', async () => {
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
    const fileTabId = result.current.tabs.find((tab) => tab.kind === 'file')!.id;
    const workspaceId = result.current.selectedWorkspaceId!;
    await act(async () => {
      await localWorkspaceAuthority.ensureDraft(workspaceId, fileTabId);
      await localWorkspaceAuthority.applyDraftPatch({
        workspaceId,
        tabId: fileTabId,
        baseRevision: 0,
        changes: [],
        fullText: 'dirty',
      });
      await result.current.refreshSnapshot(workspaceId);
    });

    await act(async () => {
      await result.current.closeWorkspaceTab(fileTabId);
    });
    expect(result.current.dirtyCloseRequest).toBeTruthy();

    await act(async () => {
      await result.current.resolveDirtyClose('discardAndClose');
    });
    await waitFor(() =>
      expect(result.current.tabs.some((tab) => tab.id === fileTabId)).toBe(false),
    );
  });
});
