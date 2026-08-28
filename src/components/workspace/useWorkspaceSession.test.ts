import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import { useClaudeChatStore } from '../../stores/claudeChatStore';
import { pty } from '../../lib/tauri-bridge';
import { localWorkspaceAuthority } from '../../lib/workspace/localAuthority';
import { workspaceClient } from '../../lib/workspace/client';
import { HOME_TAB_ID, type WorkspaceRecord } from '../../lib/workspace/types';
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
  useWorkbenchStore.setState({ followedCardIds: [] });
}

function enableTauriEnvironment() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  });
}

describe('useWorkspaceSession worktree isolation', () => {
  beforeEach(() => {
    resetStore();
    localWorkspaceAuthority.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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
      projectName: 'repo',
      projectPath: '/repo',
      worktreePath: '/repo-worktree-a',
      branchLabel: 'feature/a',
      terminalType: 'shell',
    });
    useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      worktreePath: '/repo-worktree-b',
      branchLabel: 'feature/b',
      terminalType: 'shell',
    });
    const cards = useTerminalStore.getState().cards;

    const { result, rerender } = renderHook(
      ({
        focusedCardId,
        worktree,
      }: {
        focusedCardId: string | null;
        worktree: string;
      }) =>
        useWorkspaceSession({
          cards,
          focusedCardId,
          selectedProjectPath: '/repo',
          selectedWorktreePath: worktree,
          t,
        }),
      { initialProps: { focusedCardId: a, worktree: '/repo-worktree-a' } },
    );

    await waitFor(() => expect(result.current.selectedWorkspaceId).toBeTruthy());
    await act(async () => {
      await result.current.openWorkspaceFile('/repo-worktree-a', {
        name: 'a.ts',
        path: '/repo-worktree-a/a.ts',
        isDir: false,
        isHidden: false,
      });
    });
    const wsA = result.current.selectedWorkspaceId;
    expect(result.current.tabs.some((tab) => tab.relativePath === 'a.ts')).toBe(true);

    const cardB = cards.find((card) => card.worktreePath === '/repo-worktree-b')!;
    rerender({ focusedCardId: cardB.id, worktree: '/repo-worktree-b' });
    await waitFor(() => expect(result.current.workspaceRootPath).toBe('/repo-worktree-b'));
    expect(result.current.selectedWorkspaceId).not.toBe(wsA);
    expect(
      result.current.tabs.every(
        (tab) => tab.kind !== 'file' || tab.relativePath !== 'a.ts',
      ),
    ).toBe(true);

    rerender({ focusedCardId: a, worktree: '/repo-worktree-a' });
    await waitFor(() => expect(result.current.selectedWorkspaceId).toBe(wsA));
    expect(result.current.tabs.some((tab) => tab.relativePath === 'a.ts')).toBe(true);
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
    expect(result.current.workspaceRootPath).toBe('/empty-repo');
  });

  it('keeps the latest workspace when an earlier scope load finishes late', async () => {
    const slowRecord = await localWorkspaceAuthority.ensure('/slow-repo');
    const fastRecord = await localWorkspaceAuthority.ensure('/fast-repo');
    let releaseSlow: (() => void) | null = null;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const ensureSpy = vi
      .spyOn(workspaceClient, 'ensure')
      .mockImplementation(async (rootPath) => {
        if (rootPath === '/slow-repo') {
          await slowGate;
          return slowRecord;
        }
        return fastRecord;
      });

    try {
      const { result, rerender } = renderHook(
        ({ projectPath }: { projectPath: string }) =>
          useWorkspaceSession({
            cards: [],
            focusedCardId: null,
            selectedProjectPath: projectPath,
            selectedWorktreePath: null,
            t,
          }),
        { initialProps: { projectPath: '/slow-repo' } },
      );

      rerender({ projectPath: '/fast-repo' });
      await waitFor(() => {
        expect(result.current.workspaceRootPath).toBe('/fast-repo');
      });

      await act(async () => {
        releaseSlow?.();
        await slowGate;
      });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.workspaceRootPath).toBe('/fast-repo');
      expect(result.current.selectedWorkspaceId).toBe(fastRecord.id);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('starts a fresh selection when returning to a superseded in-flight root', async () => {
    const firstRecord = await localWorkspaceAuthority.ensure('/first-repo');
    const secondRecord = await localWorkspaceAuthority.ensure('/second-repo');
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstCalls = 0;
    vi.spyOn(workspaceClient, 'ensure').mockImplementation(async (rootPath) => {
      if (rootPath === '/first-repo') {
        firstCalls += 1;
        if (firstCalls === 1) await firstGate;
        return firstRecord;
      }
      return secondRecord;
    });

    const { result } = renderHook(() =>
      useWorkspaceSession({
        cards: [],
        focusedCardId: null,
        selectedProjectPath: null,
        selectedWorktreePath: null,
        t,
      }),
    );

    let staleFirst: Promise<WorkspaceRecord | null> = Promise.resolve(null);
    act(() => {
      staleFirst = result.current.selectWorkspaceByRoot('/first-repo');
    });
    await act(async () => {
      await result.current.selectWorkspaceByRoot('/second-repo');
    });

    let returnedFirst: Promise<WorkspaceRecord | null> = Promise.resolve(null);
    act(() => {
      returnedFirst = result.current.selectWorkspaceByRoot('/first-repo');
    });
    expect(returnedFirst).not.toBe(staleFirst);
    await act(async () => {
      await returnedFirst;
    });
    expect(result.current.selectedWorkspaceId).toBe(firstRecord.id);

    await act(async () => {
      releaseFirst?.();
      await staleFirst;
    });
    expect(result.current.selectedWorkspaceId).toBe(firstRecord.id);
    expect(firstCalls).toBe(2);
  });

  it('keeps the latest terminal active when an earlier terminal open finishes late', async () => {
    const slowRecord = await localWorkspaceAuthority.ensure('/slow-terminal');
    const fastRecord = await localWorkspaceAuthority.ensure('/fast-terminal');
    const slowCardId = useTerminalStore.getState().createCard({
      projectName: 'slow',
      projectPath: '/slow-terminal',
      terminalType: 'shell',
    });
    const fastCardId = useTerminalStore.getState().createCard({
      projectName: 'fast',
      projectPath: '/fast-terminal',
      terminalType: 'shell',
    });
    const cards = useTerminalStore.getState().cards;
    const slowCard = cards.find((card) => card.id === slowCardId)!;
    const fastCard = cards.find((card) => card.id === fastCardId)!;
    let releaseSlow: (() => void) | null = null;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    vi.spyOn(workspaceClient, 'ensure').mockImplementation(async (rootPath) => {
      if (rootPath === '/slow-terminal') {
        await slowGate;
        return slowRecord;
      }
      return fastRecord;
    });

    const { result } = renderHook(() =>
      useWorkspaceSession({
        cards,
        focusedCardId: null,
        selectedProjectPath: null,
        selectedWorktreePath: null,
        t,
      }),
    );

    let slowOpen: Promise<void> = Promise.resolve();
    await act(async () => {
      slowOpen = result.current.openTerminalTab(slowCard);
      await result.current.openTerminalTab(fastCard);
    });
    expect(result.current.activeTerminalCardId).toBe(fastCardId);

    await act(async () => {
      releaseSlow?.();
      await slowOpen;
    });

    expect(result.current.workspaceRootPath).toBe('/fast-terminal');
    expect(result.current.activeTerminalCardId).toBe(fastCardId);
  });

  it('coalesces duplicate terminal-open requests for the same new card', async () => {
    const record = await localWorkspaceAuthority.ensure('/first-terminal');
    const cardId = useTerminalStore.getState().createCard({
      projectName: 'first',
      projectPath: '/first-terminal',
      terminalType: 'shell',
    });
    const cards = useTerminalStore.getState().cards;
    const card = cards.find((item) => item.id === cardId)!;
    let releaseEnsure: (() => void) | null = null;
    const ensureGate = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    vi.spyOn(workspaceClient, 'ensure').mockImplementation(async () => {
      await ensureGate;
      return record;
    });
    const openTab = vi.spyOn(workspaceClient, 'openTab');
    const { result } = renderHook(() =>
      useWorkspaceSession({
        cards,
        focusedCardId: null,
        selectedProjectPath: null,
        selectedWorktreePath: null,
        t,
      }),
    );

    let firstOpen: Promise<void> = Promise.resolve();
    let duplicateOpen: Promise<void> = Promise.resolve();
    act(() => {
      firstOpen = result.current.openTerminalTab(card);
      duplicateOpen = result.current.openTerminalTab(card);
    });
    expect(duplicateOpen).toBe(firstOpen);

    await act(async () => {
      releaseEnsure?.();
      await Promise.all([firstOpen, duplicateOpen]);
    });

    expect(openTab).toHaveBeenCalledTimes(1);
    expect(result.current.activeTerminalCardId).toBe(cardId);
  });

  it('opens the first focused terminal from live state while render cards lag', async () => {
    const cardId = useTerminalStore.getState().createCard({
      projectName: 'first live card',
      projectPath: '/first-live-card',
      terminalType: 'shell',
    });
    const { result } = renderHook(() =>
      useWorkspaceSession({
        cards: [],
        focusedCardId: cardId,
        selectedProjectPath: null,
        selectedWorktreePath: null,
        t,
      }),
    );

    await waitFor(() => {
      expect(result.current.activeTerminalCardId).toBe(cardId);
    });
    expect(result.current.workspaceRootPath).toBe('/first-live-card');
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

  it('gracefully ends the runtime before removing the card', async () => {
    enableTauriEnvironment();
    const gracefulShutdown = vi.spyOn(pty, 'gracefulShutdown').mockResolvedValue({
      attemptId: 'attempt-1',
      outcome: 'graceful',
      stage: 'shellExit',
    });
    const forceKill = vi.spyOn(pty, 'kill').mockResolvedValue();
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

    expect(gracefulShutdown).toHaveBeenCalledWith(
      id,
      expect.stringMatching(/^shutdown:/),
      'generic',
    );
    expect(forceKill).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().cards.some((card) => card.id === id)).toBe(false);
  });

  it('archives a followed card after close-and-end instead of deleting its snapshot', async () => {
    vi.spyOn(pty, 'gracefulShutdown').mockResolvedValue({
      attemptId: 'attempt-followed',
      outcome: 'graceful',
      stage: 'shellExit',
    });
    const id = useTerminalStore.getState().createCard({
      projectName: 'followed repo',
      projectPath: '/followed-repo',
      terminalType: 'shell',
    });
    useWorkbenchStore.setState({ followedCardIds: [id] });
    enableTauriEnvironment();
    const { result } = renderHook(() =>
      useWorkspaceSession({
        cards: useTerminalStore.getState().cards,
        focusedCardId: id,
        selectedProjectPath: '/followed-repo',
        selectedWorktreePath: null,
        t,
      }),
    );

    await act(async () => {
      await result.current.requestRemoveCard(id);
    });

    expect(useTerminalStore.getState().cards).not.toContainEqual(
      expect.objectContaining({ id }),
    );
    expect(useTerminalStore.getState().archivedCards).toContainEqual(
      expect.objectContaining({ id }),
    );
    expect(useWorkbenchStore.getState().followedCardIds).toContain(id);
  });

  it('keeps the card after timeout and continues the same graceful attempt without force', async () => {
    enableTauriEnvironment();
    const gracefulShutdown = vi
      .spyOn(pty, 'gracefulShutdown')
      .mockResolvedValueOnce({
        attemptId: 'attempt-1',
        outcome: 'timedOut',
        stage: 'agentExit',
      })
      .mockResolvedValueOnce({
        attemptId: 'attempt-1',
        outcome: 'graceful',
        stage: 'shellExit',
      });
    const forceKill = vi.spyOn(pty, 'kill').mockResolvedValue();
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'codex',
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

    let removed = true;
    await act(async () => {
      removed = await result.current.requestRemoveCard(id);
    });

    expect(removed).toBe(false);
    expect(result.current.terminalCloseRequest).toMatchObject({
      cardId: id,
      attemptId: 'attempt-1',
      phase: 'timedOut',
      stage: 'agentExit',
    });
    expect(useTerminalStore.getState().cards.some((card) => card.id === id)).toBe(true);
    expect(forceKill).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.resolveTerminalClose('continueWaiting');
    });

    expect(gracefulShutdown).toHaveBeenNthCalledWith(2, id, 'attempt-1', 'codex');
    expect(forceKill).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().cards.some((card) => card.id === id)).toBe(false);
  });

  it('force ends only after an explicit timeout decision', async () => {
    enableTauriEnvironment();
    vi.spyOn(pty, 'gracefulShutdown').mockResolvedValue({
      attemptId: 'attempt-force',
      outcome: 'timedOut',
      stage: 'agentExit',
    });
    const forceKill = vi.spyOn(pty, 'kill').mockResolvedValue();
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

    await act(async () => {
      await result.current.requestRemoveCard(id);
    });
    expect(forceKill).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().cards.some((card) => card.id === id)).toBe(true);

    await act(async () => {
      await result.current.resolveTerminalClose('forceEnd');
    });

    expect(forceKill).toHaveBeenCalledWith(id);
    expect(useTerminalStore.getState().cards.some((card) => card.id === id)).toBe(false);
  });

  it('releases rebuildable Claude Chat state only after runtime completion', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'claude',
    });
    useClaudeChatStore.getState().prepareCard(id, 'session-a');
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

    await act(async () => {
      await result.current.requestRemoveCard(id);
    });

    expect(useClaudeChatStore.getState().sessions[id]).toBeUndefined();
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
