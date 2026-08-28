/**
 * Worktree-scoped workspace session: shared tabs/order/drafts via workspace
 * service (or local authority), independent active tab for desktop:main.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TFunction } from 'i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import type { TerminalCard } from '../../types/terminal';
import {
  isTauriEnv,
  pty,
  type GitStatusEntry,
  type GracefulShutdownStage,
} from '../../lib/tauri-bridge';
import {
  createGracefulShutdownAttemptId,
  requestGracefulTerminalShutdown,
} from '../../lib/terminalShutdown';
import { releaseClaudeChatCard } from '../../lib/claudeChat/lifecycle';
import { effectiveWorktreePath, samePath } from '../../lib/worktreePaths';
import { workspaceClient } from '../../lib/workspace/client';
import {
  DESKTOP_MAIN_SURFACE,
  HOME_TAB_ID,
  type CloseTabDecision,
  type WorkspaceEvent,
  type WorkspaceRecord,
  type WorkspaceTab,
} from '../../lib/workspace/types';
import {
  joinRootRelative,
  pathBasename,
  relativeFromRoot,
} from '../../lib/workspace/paths';
import type { DirEntry } from '../files/fileMeta';
import type { WorkspacePanelState } from '../files/WorkspacePanel';
import { selectMountedWorkspaceEditors } from '../files/workspaceEditorLifecycle';

const DEFAULT_WORKSPACE_PANEL_STATE: WorkspacePanelState = {
  tab: 'explorer',
  selectedFilePath: null,
  selectedChangePath: null,
};

export type TerminalCloseChoice =
  | 'closeTabOnly'
  | 'closeAndEnd'
  | 'continueWaiting'
  | 'keepTerminal'
  | 'forceEnd'
  | 'cancel';
export type DirtyCloseChoice = 'saveAndClose' | 'discardAndClose' | 'cancel';

export type TerminalClosePhase =
  | 'confirm'
  | 'gracefulEnding'
  | 'timedOut'
  | 'error'
  | 'forcing';

export type CardExitMode = 'graceful' | 'continue' | 'keep' | 'force';
export type CardExitOutcome = 'ended' | 'timedOut' | 'inProgress' | 'cancelled' | 'failed';

export interface CardExitResult {
  outcome: CardExitOutcome;
  attemptId: string;
  stage?: GracefulShutdownStage;
  message?: string;
}

export interface CardExitOptions {
  attemptId?: string;
  mode?: CardExitMode;
  showDialog?: boolean;
}

export interface TerminalCloseRequest {
  workspaceId?: string;
  tabId?: string;
  cardId: string;
  title: string;
  action: 'remove' | 'archive';
  attemptId: string;
  phase: TerminalClosePhase;
  stage?: GracefulShutdownStage;
  message?: string;
}

export interface DirtyCloseRequest {
  workspaceId: string;
  tabIds: string[];
  titles: Record<string, string>;
  /** Remaining clean tab ids already approved by prepare_close. */
  cleanTabIds: string[];
  conflictTabIds: string[];
}

export interface MountedWorkspaceContentView {
  workspaceId: string;
  rootPath: string;
  tab: WorkspaceTab;
}

interface UseWorkspaceSessionOptions {
  cards: TerminalCard[];
  focusedCardId: string | null;
  selectedProjectPath: string | null;
  selectedWorktreePath: string | null;
  t: TFunction<'terminal'>;
}

function activeTabFromSnapshot(
  viewStates: { surfaceId: string; activeTabId: string }[],
  tabIds: Set<string>,
): string {
  const desktop = viewStates.find((v) => v.surfaceId === DESKTOP_MAIN_SURFACE);
  if (desktop && (desktop.activeTabId === HOME_TAB_ID || tabIds.has(desktop.activeTabId))) {
    return desktop.activeTabId;
  }
  return HOME_TAB_ID;
}

export function useWorkspaceSession({
  cards,
  focusedCardId,
  selectedProjectPath,
  selectedWorktreePath,
  t,
}: UseWorkspaceSessionOptions) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceRecord | null>(null);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string>(HOME_TAB_ID);
  const [dirtyByTabId, setDirtyByTabId] = useState<Record<string, boolean>>({});
  const [conflictByTabId, setConflictByTabId] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspacePanelState, setWorkspacePanelState] = useState<WorkspacePanelState>(
    DEFAULT_WORKSPACE_PANEL_STATE,
  );
  const [terminalCloseRequest, setTerminalCloseRequest] =
    useState<TerminalCloseRequest | null>(null);
  const [dirtyCloseRequest, setDirtyCloseRequest] = useState<DirtyCloseRequest | null>(null);
  const selectedWorkspaceIdRef = useRef(selectedWorkspaceId);
  selectedWorkspaceIdRef.current = selectedWorkspaceId;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const dirtyByTabIdRef = useRef(dirtyByTabId);
  dirtyByTabIdRef.current = dirtyByTabId;
  const terminalCloseRequestRef = useRef(terminalCloseRequest);
  terminalCloseRequestRef.current = terminalCloseRequest;
  const selectionInFlightRef = useRef<{
    rootPath: string;
    generation: number;
    promise: Promise<WorkspaceRecord | null>;
  } | null>(null);
  const navigationGenerationRef = useRef(0);
  const terminalOpenInFlightRef = useRef<{
    cardId: string;
    rootPath: string;
    generation: number;
    promise: Promise<void>;
  } | null>(null);

  const workspaceRootPath = workspace?.canonicalRoot ?? null;
  const workspaceUnavailable = workspace?.availability === 'unavailable';

  const applySnapshot = useCallback(
    (snapshot: Awaited<ReturnType<typeof workspaceClient.getSnapshot>>) => {
      // Async open flows may request another snapshot before React commits the
      // state update below. Keep the guard ref authoritative immediately so a
      // freshly selected workspace is not mistaken for the previous one.
      selectedWorkspaceIdRef.current = snapshot.workspace.id;
      setWorkspace(snapshot.workspace);
      setSelectedWorkspaceId(snapshot.workspace.id);
      setTabs(snapshot.tabs);
      const tabIds = new Set(snapshot.tabs.map((tab) => tab.id));
      setActiveTabIdState(activeTabFromSnapshot(snapshot.viewStates, tabIds));
      const dirty: Record<string, boolean> = {};
      const conflict: Record<string, boolean> = {};
      for (const meta of snapshot.draftMetas) {
        if (meta.dirty) dirty[meta.tabId] = true;
        if (meta.conflict !== 'none') conflict[meta.tabId] = true;
      }
      setDirtyByTabId(dirty);
      setConflictByTabId(conflict);
      setError(null);
    },
    [],
  );

  const refreshSnapshot = useCallback(
    async (workspaceId: string, shouldApply?: () => boolean) => {
      const snapshot = await workspaceClient.getSnapshot(workspaceId);
      if (shouldApply && !shouldApply()) return snapshot;
      if (selectedWorkspaceIdRef.current && selectedWorkspaceIdRef.current !== workspaceId) {
        return snapshot;
      }
      applySnapshot(snapshot);
      return snapshot;
    },
    [applySnapshot],
  );

  const selectionGenerationRef = useRef(0);
  const selectWorkspaceByRoot = useCallback(
    (rootPath: string): Promise<WorkspaceRecord | null> => {
      const trimmed = rootPath.trim();
      if (!trimmed) return Promise.resolve(null);
      const inFlight = selectionInFlightRef.current;
      if (
        inFlight &&
        samePath(inFlight.rootPath, trimmed) &&
        inFlight.generation === selectionGenerationRef.current
      ) {
        return inFlight.promise;
      }
      const generation = selectionGenerationRef.current + 1;
      selectionGenerationRef.current = generation;
      setLoading(true);
      setError(null);
      const promise = (async () => {
        try {
          const record = await workspaceClient.ensure(trimmed);
          const snapshot = await workspaceClient.getSnapshot(record.id);
          if (selectionGenerationRef.current !== generation) return record;
          applySnapshot(snapshot);
          return record;
        } catch (err) {
          if (selectionGenerationRef.current !== generation) return null;
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          return null;
        } finally {
          if (selectionGenerationRef.current === generation) {
            setLoading(false);
          }
          if (selectionInFlightRef.current?.generation === generation) {
            selectionInFlightRef.current = null;
          }
        }
      })();
      selectionInFlightRef.current = { rootPath: trimmed, generation, promise };
      return promise;
    },
    [applySnapshot],
  );

  // Keep workspace metadata ready when the project/worktree scope changes.
  // Page visibility belongs to desktop navigation, not this data hook.
  useEffect(() => {
    const worktree = selectedWorktreePath?.trim() || null;
    const project = selectedProjectPath?.trim() || null;
    if (worktree) {
      void selectWorkspaceByRoot(worktree);
      return;
    }
    if (project) {
      void selectWorkspaceByRoot(project);
    }
  }, [selectedProjectPath, selectedWorktreePath, selectWorkspaceByRoot]);

  // Subscribe to shared tab/draft events for the selected workspace.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void workspaceClient.onEvent((event: WorkspaceEvent) => {
      const workspaceId = selectedWorkspaceIdRef.current;
      if (!workspaceId || cancelled) return;
      if (!('workspaceId' in event) || event.workspaceId !== workspaceId) return;
      if (event.type === 'tabsChanged' || event.type === 'workspaceChanged') {
        void refreshSnapshot(workspaceId);
        return;
      }
      if (event.type === 'draftRevision') {
        setDirtyByTabId((current) => {
          if (event.dirty) {
            if (current[event.tabId]) return current;
            return { ...current, [event.tabId]: true };
          }
          if (!current[event.tabId]) return current;
          const { [event.tabId]: _removed, ...rest } = current;
          return rest;
        });
        setConflictByTabId((current) => {
          if (event.conflict !== 'none') {
            if (current[event.tabId]) return current;
            return { ...current, [event.tabId]: true };
          }
          if (!current[event.tabId]) return current;
          const { [event.tabId]: _removed, ...rest } = current;
          return rest;
        });
      }
      if (event.type === 'conflict') {
        setConflictByTabId((current) => {
          if (event.conflict !== 'none') {
            if (current[event.tabId]) return current;
            return { ...current, [event.tabId]: true };
          }
          if (!current[event.tabId]) return current;
          const { [event.tabId]: _removed, ...rest } = current;
          return rest;
        });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshSnapshot]);

  const setActiveTabId = useCallback(
    async (tabId: string) => {
      navigationGenerationRef.current += 1;
      const workspaceId = selectedWorkspaceIdRef.current;
      setActiveTabIdState(tabId);
      if (!workspaceId) return;
      try {
        await workspaceClient.setActiveTab(workspaceId, tabId, DESKTOP_MAIN_SURFACE);
      } catch {
        /* keep local active tab even if persistence fails */
      }
    },
    [],
  );

  const openTerminalTab = useCallback(
    (card: TerminalCard): Promise<void> => {
      const root = effectiveWorktreePath(card);
      const inFlight = terminalOpenInFlightRef.current;
      if (
        inFlight &&
        inFlight.cardId === card.id &&
        samePath(inFlight.rootPath, root) &&
        inFlight.generation === navigationGenerationRef.current
      ) {
        return inFlight.promise;
      }

      const generation = navigationGenerationRef.current + 1;
      navigationGenerationRef.current = generation;
      const isLatest = () => navigationGenerationRef.current === generation;
      const promise = (async () => {
        try {
          const record = await selectWorkspaceByRoot(root);
          if (!record || !isLatest()) return;
          const tab = await workspaceClient.openTab(record.id, {
            kind: 'terminal',
            title: card.projectName || pathBasename(root),
            cardId: card.id,
          });
          if (!isLatest()) return;
          await workspaceClient.setActiveTab(record.id, tab.id, DESKTOP_MAIN_SURFACE);
          if (!isLatest()) return;
          setActiveTabIdState(tab.id);
          await refreshSnapshot(record.id, isLatest);
        } finally {
          if (terminalOpenInFlightRef.current?.generation === generation) {
            terminalOpenInFlightRef.current = null;
          }
        }
      });
      const running = promise();
      terminalOpenInFlightRef.current = {
        cardId: card.id,
        rootPath: root,
        generation,
        promise: running,
      };
      return running;
    },
    [refreshSnapshot, selectWorkspaceByRoot],
  );

  const openWorkspaceFile = useCallback(
    async (rootPath: string, entry: DirEntry) => {
      const generation = navigationGenerationRef.current + 1;
      navigationGenerationRef.current = generation;
      const isLatest = () => navigationGenerationRef.current === generation;
      const record = await selectWorkspaceByRoot(rootPath);
      if (!record || !isLatest()) return;
      const relativePath = relativeFromRoot(rootPath, entry.path);
      const tab = await workspaceClient.openTab(record.id, {
        kind: 'file',
        title: entry.name || pathBasename(entry.path),
        relativePath,
      });
      if (!isLatest()) return;
      await workspaceClient.setActiveTab(record.id, tab.id, DESKTOP_MAIN_SURFACE);
      if (!isLatest()) return;
      setActiveTabIdState(tab.id);
      setWorkspacePanelState((state) => ({
        ...state,
        selectedFilePath: entry.path,
      }));
      await refreshSnapshot(record.id, isLatest);
    },
    [refreshSnapshot, selectWorkspaceByRoot],
  );

  const openWorkspaceDiff = useCallback(
    async (entry: GitStatusEntry) => {
      const generation = navigationGenerationRef.current + 1;
      navigationGenerationRef.current = generation;
      const isLatest = () => navigationGenerationRef.current === generation;
      const root = entry.repositoryRoot;
      const record = await selectWorkspaceByRoot(root);
      if (!record || !isLatest()) return;
      const relativePath = relativeFromRoot(root, entry.path);
      const tab = await workspaceClient.openTab(record.id, {
        kind: 'diff',
        title: pathBasename(entry.path),
        relativePath,
      });
      if (!isLatest()) return;
      await workspaceClient.setActiveTab(record.id, tab.id, DESKTOP_MAIN_SURFACE);
      if (!isLatest()) return;
      setActiveTabIdState(tab.id);
      setWorkspacePanelState((state) => ({
        ...state,
        selectedChangePath: entry.path,
      }));
      await refreshSnapshot(record.id, isLatest);
    },
    [refreshSnapshot, selectWorkspaceByRoot],
  );

  const reorderTabs = useCallback(
    async (orderedTabIds: string[]) => {
      const workspaceId = selectedWorkspaceIdRef.current;
      if (!workspaceId) return;
      const withoutHome = orderedTabIds.filter((id) => id !== HOME_TAB_ID);
      const next = await workspaceClient.reorderTabs(workspaceId, withoutHome);
      setTabs(next);
    },
    [],
  );

  const commitCloseDecisions = useCallback(
    async (workspaceId: string, decisions: CloseTabDecision[]) => {
      const closed = await workspaceClient.commitClose(workspaceId, decisions);
      await refreshSnapshot(workspaceId);
      if (closed.includes(activeTabId)) {
        const remaining = tabsRef.current.filter((tab) => !closed.includes(tab.id));
        const nextActive =
          remaining.find((tab) => tab.id === activeTabId)?.id ??
          remaining[remaining.length - 1]?.id ??
          HOME_TAB_ID;
        await setActiveTabId(nextActive);
      }
      return closed;
    },
    [activeTabId, refreshSnapshot, setActiveTabId],
  );

  const removeTerminalTabForCard = useCallback(async (cardId: string) => {
    const workspaceId = selectedWorkspaceIdRef.current;
    if (workspaceId) {
      const tabId = `terminal:${cardId}`;
      const has = tabsRef.current.some((tab) => tab.id === tabId);
      if (has) {
        await workspaceClient.commitClose(workspaceId, [
          { tabId, kind: 'closeClean' },
        ]);
        await refreshSnapshot(workspaceId);
      }
    }
  }, [refreshSnapshot]);

  const resolveDirtyClose = useCallback(
    async (choice: DirtyCloseChoice) => {
      const request = dirtyCloseRequest;
      if (!request) return;
      if (choice === 'cancel' || request.conflictTabIds.length > 0) {
        setDirtyCloseRequest(null);
        pendingContentCloseRef.current = null;
        return;
      }
      const decisions: CloseTabDecision[] = [
        ...request.cleanTabIds.map((tabId) => ({
          tabId,
          kind: 'closeClean' as const,
        })),
        ...request.tabIds.map((tabId) => ({
          tabId,
          kind:
            choice === 'saveAndClose'
              ? ('saveAndClose' as const)
              : ('discardAndClose' as const),
        })),
      ];
      try {
        await commitCloseDecisions(request.workspaceId, decisions);
        setDirtyCloseRequest(null);
        pendingContentCloseRef.current = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('file_conflict')) {
          setDirtyCloseRequest({
            ...request,
            conflictTabIds: request.tabIds,
          });
          return;
        }
        setError(message);
        setDirtyCloseRequest(null);
      }
    },
    [commitCloseDecisions, dirtyCloseRequest],
  );

  const pendingContentCloseRef = useRef<string[] | null>(null);

  const closeTabsViaCoordinator = useCallback(
    async (tabIds: string[]): Promise<boolean> => {
      const workspaceId = selectedWorkspaceIdRef.current;
      if (!workspaceId || tabIds.length === 0) return true;
      const targets = tabIds.filter((id) => id !== HOME_TAB_ID);
      if (targets.length === 0) return true;

      const currentTabs = tabsRef.current;
      // Single terminal close → dialog (default path from tab X button).
      if (targets.length === 1) {
        const only = currentTabs.find((tab) => tab.id === targets[0]);
        if (only?.kind === 'terminal' && only.cardId) {
          setTerminalCloseRequest({
            workspaceId,
            tabId: only.id,
            cardId: only.cardId,
            title: only.title,
            action: 'remove',
            attemptId: createGracefulShutdownAttemptId(only.cardId),
            phase: 'confirm',
          });
          return false;
        }
      }

      const terminalTargets = targets.filter((id) =>
        currentTabs.some((tab) => tab.id === id && tab.kind === 'terminal'),
      );
      const contentTargets = targets.filter((id) => !terminalTargets.includes(id));

      // Bulk: close terminal tabs as close-tab-only (no end) without per-tab dialogs.
      for (const tabId of terminalTargets) {
        await commitCloseDecisions(workspaceId, [{ tabId, kind: 'closeClean' }]);
      }

      if (contentTargets.length === 0) return true;

      const prepared = await workspaceClient.prepareClose(workspaceId, contentTargets);
      if (prepared.conflictTabIds.length > 0) {
        setDirtyCloseRequest({
          workspaceId,
          tabIds: prepared.dirtyTabIds,
          titles: Object.fromEntries(
            contentTargets.map((id) => {
              const tab = currentTabs.find((item) => item.id === id);
              return [id, tab?.title ?? id];
            }),
          ),
          cleanTabIds: prepared.cleanTabIds,
          conflictTabIds: prepared.conflictTabIds,
        });
        return false;
      }

      if (prepared.dirtyTabIds.length === 0) {
        await commitCloseDecisions(
          workspaceId,
          prepared.cleanTabIds.map((tabId) => ({ tabId, kind: 'closeClean' as const })),
        );
        return true;
      }

      pendingContentCloseRef.current = contentTargets;
      setDirtyCloseRequest({
        workspaceId,
        tabIds: prepared.dirtyTabIds,
        titles: Object.fromEntries(
          prepared.dirtyTabIds.map((id) => {
            const tab = currentTabs.find((item) => item.id === id);
            return [id, tab?.title ?? id];
          }),
        ),
        cleanTabIds: prepared.cleanTabIds,
        conflictTabIds: [],
      });
      return false;
    },
    [commitCloseDecisions],
  );

  const closeWorkspaceTab = useCallback(
    (tabId: string) => closeTabsViaCoordinator([tabId]),
    [closeTabsViaCoordinator],
  );

  const closeAllWorkspaceTabs = useCallback(
    () => closeTabsViaCoordinator(tabsRef.current.map((tab) => tab.id)),
    [closeTabsViaCoordinator],
  );

  const closeOtherWorkspaceTabs = useCallback(
    (tabId: string) =>
      closeTabsViaCoordinator(
        tabsRef.current.filter((tab) => tab.id !== tabId).map((tab) => tab.id),
      ),
    [closeTabsViaCoordinator],
  );

  const finalizeCardExit = useCallback(
    async (
      card: TerminalCard,
      action: 'remove' | 'archive',
      attemptId: string,
    ): Promise<CardExitResult> => {
      // The PTY has already ended (or force was explicitly confirmed). Release
      // provider side resources before committing the irreversible card state.
      if (card.terminalType === 'claude') {
        await releaseClaudeChatCard(card.id, action);
      }

      // Close only the terminal tab. File/diff drafts remain worktree-owned.
      await removeTerminalTabForCard(card.id);

      const preserveWorkspaceScope =
        Boolean(workspaceRootPath) &&
        samePath(effectiveWorktreePath(card), workspaceRootPath) &&
        tabsRef.current.some((tab) => tab.kind === 'file' || tab.kind === 'diff');
      const store = useTerminalStore.getState();
      if (store.cards.some((candidate) => candidate.id === card.id)) {
        const keepFollowedSnapshot =
          action === 'remove' &&
          useWorkbenchStore.getState().followedCardIds.includes(card.id);
        if (action === 'archive' || keepFollowedSnapshot) store.archiveCard(card.id);
        else store.removeCard(card.id);
      }
      if (preserveWorkspaceScope) {
        const nextStore = useTerminalStore.getState();
        if (card.worktreePath) {
          nextStore.selectWorktree(card.projectPath, card.worktreePath, card.branchLabel);
        } else {
          nextStore.selectProject(card.projectPath);
        }
      }
      return { outcome: 'ended', attemptId, stage: 'shellExit' };
    },
    [removeTerminalTabForCard, workspaceRootPath],
  );

  const requestCardExit = useCallback(
    async (
      cardId: string,
      action: 'remove' | 'archive',
      options: CardExitOptions = {},
    ): Promise<CardExitResult> => {
      const mode = options.mode ?? 'graceful';
      const existingRequest = terminalCloseRequestRef.current;
      const requestedAttemptId =
        options.attemptId ??
        (existingRequest?.cardId === cardId ? existingRequest.attemptId : undefined) ??
        createGracefulShutdownAttemptId(cardId);
      const card = useTerminalStore
        .getState()
        .cards
        .find((candidate) => candidate.id === cardId);
      if (!card) {
        return {
          outcome: 'ended',
          attemptId: requestedAttemptId,
          stage: 'shellExit',
        };
      }

      const showDialog = options.showDialog ?? true;
      const publishPhase = (
        phase: TerminalClosePhase,
        update: Partial<TerminalCloseRequest> = {},
      ) => {
        if (!showDialog) return;
        const base =
          terminalCloseRequestRef.current?.cardId === cardId
            ? terminalCloseRequestRef.current
            : null;
        setTerminalCloseRequest({
          workspaceId: base?.workspaceId,
          tabId: base?.tabId,
          cardId,
          title: base?.title ?? card.projectName,
          action,
          attemptId: update.attemptId ?? base?.attemptId ?? requestedAttemptId,
          phase,
          stage: update.stage ?? base?.stage,
          message: update.message,
        });
      };

      if (mode === 'keep') {
        if (isTauriEnv()) {
          try {
            await pty.cancelGracefulShutdown(card.ptyId || card.id, requestedAttemptId);
          } catch {
            // A natural EOF can win the race with Keep. The card remains
            // authoritative until the normal exit/finalize path observes it.
          }
        }
        if (showDialog && terminalCloseRequestRef.current?.cardId === cardId) {
          setTerminalCloseRequest(null);
        }
        return { outcome: 'cancelled', attemptId: requestedAttemptId };
      }

      if (mode === 'force') {
        publishPhase('forcing');
        if (isTauriEnv()) {
          try {
            await pty.kill(card.ptyId || card.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.toLowerCase().includes('not found')) {
              publishPhase('error', { message });
              return {
                outcome: 'failed',
                attemptId: requestedAttemptId,
                message,
              };
            }
          }
        }
        const result = await finalizeCardExit(card, action, requestedAttemptId);
        if (showDialog) setTerminalCloseRequest(null);
        return result;
      }

      publishPhase('gracefulEnding');
      try {
        const shutdown = await requestGracefulTerminalShutdown(card, requestedAttemptId);
        if (shutdown.outcome === 'graceful' || shutdown.outcome === 'alreadyExited') {
          const result = await finalizeCardExit(card, action, shutdown.attemptId);
          if (showDialog) setTerminalCloseRequest(null);
          return result;
        }

        const outcome = shutdown.outcome === 'timedOut' ? 'timedOut' : 'inProgress';
        publishPhase('timedOut', {
          attemptId: shutdown.attemptId,
          stage: shutdown.stage,
        });
        return {
          outcome,
          attemptId: shutdown.attemptId,
          stage: shutdown.stage,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publishPhase('error', { message });
        return {
          outcome: 'failed',
          attemptId: requestedAttemptId,
          message,
        };
      }
    },
    [finalizeCardExit],
  );

  const requestRemoveCard = useCallback(
    async (cardId: string) =>
      (await requestCardExit(cardId, 'remove', { showDialog: true })).outcome ===
      'ended',
    [requestCardExit],
  );

  const requestArchiveCard = useCallback(
    async (cardId: string) =>
      (await requestCardExit(cardId, 'archive', { showDialog: true })).outcome ===
      'ended',
    [requestCardExit],
  );

  const resolveTerminalClose = useCallback(
    async (
      choice: TerminalCloseChoice,
    ): Promise<'closed' | 'ended' | 'pending' | 'cancelled'> => {
      const request = terminalCloseRequestRef.current;
      if (!request) return 'cancelled';

      if (choice === 'cancel') {
        if (request.phase === 'confirm') setTerminalCloseRequest(null);
        return 'cancelled';
      }
      if (choice === 'closeTabOnly') {
        if (!request.workspaceId || !request.tabId || request.phase !== 'confirm') {
          return 'cancelled';
        }
        await commitCloseDecisions(request.workspaceId, [
          { tabId: request.tabId, kind: 'closeClean' },
        ]);
        setTerminalCloseRequest(null);
        return 'closed';
      }

      const mode: CardExitMode =
        choice === 'continueWaiting'
          ? 'continue'
          : choice === 'keepTerminal'
            ? 'keep'
            : choice === 'forceEnd'
              ? 'force'
              : 'graceful';
      const result = await requestCardExit(request.cardId, request.action, {
        attemptId: request.attemptId,
        mode,
        showDialog: true,
      });
      if (result.outcome === 'ended') return 'ended';
      if (result.outcome === 'cancelled') return 'cancelled';
      return 'pending';
    },
    [commitCloseDecisions, requestCardExit],
  );

  const naturalFinalizeIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const request = terminalCloseRequest;
    if (!request || (request.phase !== 'timedOut' && request.phase !== 'error')) return;
    const card = cards.find((candidate) => candidate.id === request.cardId);
    if (!card || (card.status !== 'completed' && card.status !== 'failed')) return;
    if (naturalFinalizeIdsRef.current.has(card.id)) return;
    naturalFinalizeIdsRef.current.add(card.id);
    void finalizeCardExit(card, request.action, request.attemptId)
      .then(() => {
        if (terminalCloseRequestRef.current?.cardId === card.id) {
          setTerminalCloseRequest(null);
        }
      })
      .finally(() => naturalFinalizeIdsRef.current.delete(card.id));
  }, [cards, finalizeCardExit, terminalCloseRequest]);

  /**
   * Directory/config change: drop only this terminal tab; do not migrate or
   * delete file/diff drafts belonging to the previous worktree.
   */
  const requestCardWorkspaceReset = useCallback(
    async (cardId: string): Promise<boolean> => {
      const store = useTerminalStore.getState();
      if (!store.cards.some((card) => card.id === cardId)) return false;
      await removeTerminalTabForCard(cardId);
      return true;
    },
    [removeTerminalTabForCard],
  );

  const markWorkspaceTabDirty = useCallback(
    (workspaceId: string, tabId: string, dirty: boolean) => {
      const alreadyDirty = Boolean(dirtyByTabIdRef.current[tabId]);
      if (dirty === alreadyDirty) return;
      setDirtyByTabId((current) => {
        if (dirty) {
          if (current[tabId]) return current;
          return { ...current, [tabId]: true };
        }
        if (!current[tabId]) return current;
        const { [tabId]: _removed, ...rest } = current;
        return rest;
      });
      workspaceClient.markDirtyLocal(workspaceId, tabId, dirty);
    },
    [],
  );

  const handleWorkspacePanelStateChange = useCallback((panelState: WorkspacePanelState) => {
    setWorkspacePanelState(panelState);
  }, []);

  const activateTerminalForCard = useCallback(
    (cardId: string) => {
      const card = useTerminalStore.getState().cards.find((item) => item.id === cardId);
      if (!card) {
        void setActiveTabId(HOME_TAB_ID);
        return;
      }
      void openTerminalTab(card);
    },
    [openTerminalTab, setActiveTabId],
  );

  // When focusing a card, open/focus its terminal tab in the shared workspace.
  const lastFocusedTerminalRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedCardId) {
      lastFocusedTerminalRef.current = null;
      navigationGenerationRef.current += 1;
      return;
    }
    if (lastFocusedTerminalRef.current === focusedCardId) return;
    const card = useTerminalStore
      .getState()
      .cards.find((item) => item.id === focusedCardId);
    if (!card) return;
    lastFocusedTerminalRef.current = focusedCardId;
    void openTerminalTab(card);
  }, [focusedCardId, cards, openTerminalTab]);

  const activeTab =
    activeTabId === HOME_TAB_ID
      ? null
      : tabs.find((tab) => tab.id === activeTabId) ?? null;

  const homeActive = activeTabId === HOME_TAB_ID;
  const terminalTabActive = activeTab?.kind === 'terminal';
  const activeTerminalCardId =
    activeTab?.kind === 'terminal' ? activeTab.cardId ?? null : null;

  const activeWorkspaceFilePath = useMemo(() => {
    if (activeTab?.kind !== 'file' || !activeTab.relativePath || !workspaceRootPath) {
      return null;
    }
    return joinRootRelative(workspaceRootPath, activeTab.relativePath);
  }, [activeTab, workspaceRootPath]);

  const activeWorkspaceDiffPath = useMemo(() => {
    if (activeTab?.kind !== 'diff' || !activeTab.relativePath) return null;
    return activeTab.relativePath;
  }, [activeTab]);

  const mountedWorkspaceContentViews = useMemo((): MountedWorkspaceContentView[] => {
    if (!selectedWorkspaceId || !workspaceRootPath) return [];
    const candidates = tabs
      .filter((tab) => tab.kind === 'file' || tab.kind === 'diff')
      .map((tab) => ({
        workspaceId: selectedWorkspaceId,
        tabId: tab.id,
        kind: tab.kind,
        dirty: Boolean(dirtyByTabId[tab.id]),
        current: activeTabId === tab.id,
        selectedWorkspace: true,
        tab,
      }));

    const { mounted } = selectMountedWorkspaceEditors(
      candidates.map((candidate) => ({
        workspaceId: candidate.workspaceId,
        tabId: candidate.tabId,
        kind: candidate.kind,
        dirty: candidate.dirty,
        current: candidate.current,
        selectedWorkspace: candidate.selectedWorkspace,
      })),
    );
    const mountedKeys = new Set(mounted.map((item) => `${item.workspaceId}::${item.tabId}`));
    return candidates
      .filter((candidate) =>
        mountedKeys.has(`${candidate.workspaceId}::${candidate.tabId}`),
      )
      .map(({ workspaceId, tab }) => ({
        workspaceId,
        rootPath: workspaceRootPath,
        tab,
      }));
  }, [
    activeTabId,
    dirtyByTabId,
    selectedWorkspaceId,
    tabs,
    workspaceRootPath,
  ]);

  const orderedStripTabs = useMemo(() => {
    return [...tabs].sort((a, b) => a.sharedOrder - b.sharedOrder);
  }, [tabs]);

  const workspaceCards = useMemo(() => {
    if (!workspaceRootPath) return [];
    return cards.filter((card) =>
      samePath(effectiveWorktreePath(card), workspaceRootPath),
    );
  }, [cards, workspaceRootPath]);

  const diagnostics = useMemo(
    () => ({
      selectedWorkspaceId,
      tabCount: tabs.length + (selectedWorkspaceId ? 1 : 0), // include home when selected
      dirtyTabCount: Object.values(dirtyByTabId).filter(Boolean).length,
      conflictTabCount: Object.values(conflictByTabId).filter(Boolean).length,
      activeTabCount: selectedWorkspaceId ? 1 : 0,
      liveEditorInstanceCount: mountedWorkspaceContentViews.length,
    }),
    [
      conflictByTabId,
      dirtyByTabId,
      mountedWorkspaceContentViews.length,
      selectedWorkspaceId,
      tabs.length,
    ],
  );

  return {
    selectedWorkspaceId,
    workspace,
    workspaceRootPath,
    workspaceUnavailable,
    loading,
    error,
    tabs: orderedStripTabs,
    activeTabId,
    dirtyByTabId,
    conflictByTabId,
    workspacePanelState,
    homeActive,
    terminalTabActive,
    activeTerminalCardId,
    activeWorkspaceFilePath,
    activeWorkspaceDiffPath,
    mountedWorkspaceContentViews,
    workspaceCards,
    diagnostics,
    terminalCloseRequest,
    dirtyCloseRequest,
    selectWorkspaceByRoot,
    setActiveTabId,
    openTerminalTab,
    openWorkspaceFile,
    openWorkspaceDiff,
    reorderTabs,
    closeWorkspaceTab,
    closeAllWorkspaceTabs,
    closeOtherWorkspaceTabs,
    resolveTerminalClose,
    resolveDirtyClose,
    markWorkspaceTabDirty,
    handleWorkspacePanelStateChange,
    activateTerminalForCard,
    requestCardExit,
    requestRemoveCard,
    requestArchiveCard,
    requestCardWorkspaceReset,
    refreshSnapshot,
    t,
  };
}

export type WorkspaceSession = ReturnType<typeof useWorkspaceSession>;
