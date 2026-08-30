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

  it('activates an exact existing catalog tab without opening or recreating it', async () => {
    const cardId = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const record = await workspaceClient.ensure('/repo');
    const tab = await workspaceClient.openTab(record.id, {
      kind: 'terminal',
      cardId,
      title: 'repo',
    });
    const openTab = vi.spyOn(workspaceClient, 'openTab');
    const setActiveTab = vi.spyOn(workspaceClient, 'setActiveTab');
    const { result } = renderHook(() =>
      useWorkspaceSession({
        cards: useTerminalStore.getState().cards,
        focusedCardId: null,
        selectedProjectPath: null,
        selectedWorktreePath: null,
        t,
      }),
    );

    let activated = null;
    await act(async () => {
      activated = await result.current.activateExistingWorkspaceTab({
        workspaceId: record.id,
        rootPath: '/repo',
        tabId: tab.id,
        kind: 'terminal',
        cardId,
        relativePath: null,
      });
    });

    expect(activated).toEqual(expect.objectContaining({ id: tab.id }));
    expect(openTab).not.toHaveBeenCalled();
    expect(setActiveTab).toHaveBeenCalledWith(record.id, tab.id, 'desktop:main');
    expect(result.current.activeTabId).toBe(tab.id);
    expect(result.current.tabs.filter((candidate) => candidate.id === tab.id)).toHaveLength(1);
  });

  it('lets the same-root scope effect join a targeted catalog activation', async () => {
    const record = await workspaceClient.ensure('/repo');
    const tab = await workspaceClient.openTab(record.id, {
      kind: 'file',
      relativePath: 'src/app.ts',
      title: 'app.ts',
    });
    const originalGetSnapshot = workspaceClient.getSnapshot.bind(workspaceClient);
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const getSnapshot = vi.spyOn(workspaceClient, 'getSnapshot')
      .mockImplementation(async (workspaceId) => {
        if (workspaceId === record.id) await snapshotGate;
        return originalGetSnapshot(workspaceId);
      });
    const ensure = vi.spyOn(workspaceClient, 'ensure');
    const cards = useTerminalStore.getState().cards;
    const { result } = renderHook(() =>
      useWorkspaceSession({
        cards,
        focusedCardId: null,
        selectedProjectPath: null,
        selectedWorktreePath: null,
        t,
      }),
    );

    let activation!: ReturnType<typeof result.current.activateExistingWorkspaceTab>;
    let selection!: ReturnType<typeof result.current.selectWorkspaceByRoot>;
    act(() => {
      activation = result.current.activateExistingWorkspaceTab({
        workspaceId: record.id,
        rootPath: '/repo',
        tabId: tab.id,
        kind: 'file',
        cardId: null,
        relativePath: 'src/app.ts',
      });
      selection = result.current.selectWorkspaceByRoot('/repo');
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    releaseSnapshot();

    let activated = null;
    let selected = null;
    await act(async () => {
      [activated, selected] = await Promise.all([activation, selection]);
    });
    expect(activated).toEqual(expect.objectContaining({ id: tab.id }));
    expect(selected).toEqual(expect.objectContaining({ id: record.id }));
    await waitFor(() => expect(result.current.activeTabId).toBe(tab.id));
    expect(result.current.selectedWorkspaceId).toBe(record.id);
  });

  it('rejects a stale catalog identity and a tab closed during activation', async () => {
    const record = await workspaceClient.ensure('/repo');
    const tab = await workspaceClient.openTab(record.id, {
      kind: 'file',
      relativePath: 'src/app.ts',
      title: 'app.ts',
    });
    const setActiveTab = vi.spyOn(workspaceClient, 'setActiveTab');
    const openTab = vi.spyOn(workspaceClient, 'openTab');
    const { result } = renderHook(() =>
      useWorkspaceSession({
        cards: [],
        focusedCardId: null,
        selectedProjectPath: null,
        selectedWorktreePath: null,
        t,
      }),
    );

    let mismatch = null;
    await act(async () => {
      mismatch = await result.current.activateExistingWorkspaceTab({
        workspaceId: record.id,
        rootPath: '/repo',
        tabId: tab.id,
        kind: 'file',
        cardId: null,
        relativePath: 'src/other.ts',
      });
    });
    expect(mismatch).toBeNull();
    expect(setActiveTab).not.toHaveBeenCalled();

    const originalGetSnapshot = workspaceClient.getSnapshot.bind(workspaceClient);
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    vi.spyOn(workspaceClient, 'getSnapshot').mockImplementation(async (workspaceId) => {
      if (workspaceId === record.id) await snapshotGate;
      return originalGetSnapshot(workspaceId);
    });
    let activationPromise!: ReturnType<typeof result.current.activateExistingWorkspaceTab>;
    act(() => {
      activationPromise = result.current.activateExistingWorkspaceTab({
        workspaceId: record.id,
        rootPath: '/repo',
        tabId: tab.id,
        kind: 'file',
        cardId: null,
        relativePath: 'src/app.ts',
      });
    });
    await workspaceClient.commitClose(record.id, [
      { tabId: tab.id, kind: 'closeClean' },
    ]);
    releaseSnapshot();

    let closedResult = null;
    await act(async () => {
      closedResult = await activationPromise;
    });
    expect(closedResult).toBeNull();
    expect(openTab).not.toHaveBeenCalled();
    expect((await originalGetSnapshot(record.id)).tabs.some((candidate) => candidate.id === tab.id))
      .toBe(false);
  });

  it('serializes cross-root authority writes so a slower A cannot overwrite B', async () => {
    const workspaceA = await workspaceClient.ensure('/repo-a');
    const workspaceB = await workspaceClient.ensure('/repo-b');
    const tabA = await workspaceClient.openTab(workspaceA.id, {
      kind: 'file',
      relativePath: 'a.ts',
      title: 'a.ts',
    });
    const tabB = await workspaceClient.openTab(workspaceB.id, {
      kind: 'file',
      relativePath: 'b.ts',
      title: 'b.ts',
    });
    const originalSetActiveTab = workspaceClient.setActiveTab.bind(workspaceClient);
    let releaseA!: () => void;
    const aWriteGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const completedWrites: string[] = [];
    const setActiveTab = vi.spyOn(workspaceClient, 'setActiveTab')
      .mockImplementation(async (workspaceId, tabId, surfaceId) => {
        // Model the backend completing A after the user has already chosen B.
        // The hook must queue B behind that in-flight write, then reassert B.
        if (tabId === tabA.id) await aWriteGate;
        const result = await originalSetActiveTab(workspaceId, tabId, surfaceId);
        completedWrites.push(tabId);
        return result;
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

    let activationA!: ReturnType<typeof result.current.activateExistingWorkspaceTab>;
    act(() => {
      activationA = result.current.activateExistingWorkspaceTab({
        workspaceId: workspaceA.id,
        rootPath: '/repo-a',
        tabId: tabA.id,
        kind: 'file',
        cardId: null,
        relativePath: 'a.ts',
      });
    });
    await waitFor(() => expect(setActiveTab).toHaveBeenCalledWith(
      workspaceA.id,
      tabA.id,
      'desktop:main',
    ));
    let activationB!: ReturnType<typeof result.current.activateExistingWorkspaceTab>;
    act(() => {
      activationB = result.current.activateExistingWorkspaceTab({
        workspaceId: workspaceB.id,
        rootPath: '/repo-b',
        tabId: tabB.id,
        kind: 'file',
        cardId: null,
        relativePath: 'b.ts',
      });
    });
    expect(setActiveTab).not.toHaveBeenCalledWith(workspaceB.id, tabB.id, 'desktop:main');
    releaseA();
    await act(async () => {
      await Promise.all([activationA, activationB]);
    });

    expect(completedWrites).toEqual([tabA.id, tabB.id]);
    const authorityB = await workspaceClient.getSnapshot(workspaceB.id);
    expect(authorityB.viewStates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surfaceId: 'desktop:main',
        activeTabId: tabB.id,
      }),
    ]));
    expect(result.current.selectedWorkspaceId).toBe(workspaceB.id);
    expect(result.current.activeTabId).toBe(tabB.id);
  });

  it('serializes exact-tab authority writes so the latest same-workspace choice wins', async () => {
    const workspace = await workspaceClient.ensure('/repo');
    const tabA = await workspaceClient.openTab(workspace.id, {
      kind: 'file',
      relativePath: 'a.ts',
      title: 'a.ts',
    });
    const tabB = await workspaceClient.openTab(workspace.id, {
      kind: 'file',
      relativePath: 'b.ts',
      title: 'b.ts',
    });
    const originalSetActiveTab = workspaceClient.setActiveTab.bind(workspaceClient);
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const setActiveTab = vi.spyOn(workspaceClient, 'setActiveTab')
      .mockImplementation(async (workspaceId, tabId, surfaceId) => {
        if (tabId === tabA.id) await gateA;
        return originalSetActiveTab(workspaceId, tabId, surfaceId);
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

    let activationA!: ReturnType<typeof result.current.activateExistingWorkspaceTab>;
    let activationB!: ReturnType<typeof result.current.activateExistingWorkspaceTab>;
    act(() => {
      activationA = result.current.activateExistingWorkspaceTab({
        workspaceId: workspace.id,
        rootPath: '/repo',
        tabId: tabA.id,
        kind: 'file',
        cardId: null,
        relativePath: 'a.ts',
      });
    });
    await waitFor(() => expect(setActiveTab).toHaveBeenCalledWith(
      workspace.id,
      tabA.id,
      'desktop:main',
    ));
    act(() => {
      activationB = result.current.activateExistingWorkspaceTab({
        workspaceId: workspace.id,
        rootPath: '/repo',
        tabId: tabB.id,
        kind: 'file',
        cardId: null,
        relativePath: 'b.ts',
      });
    });
    expect(setActiveTab).not.toHaveBeenCalledWith(workspace.id, tabB.id, 'desktop:main');

    releaseA();
    await act(async () => {
      await Promise.all([activationA, activationB]);
    });

    const authoritative = await workspaceClient.getSnapshot(workspace.id);
    expect(authoritative.viewStates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surfaceId: 'desktop:main',
        activeTabId: tabB.id,
      }),
    ]));
    expect(result.current.activeTabId).toBe(tabB.id);
  });
});
