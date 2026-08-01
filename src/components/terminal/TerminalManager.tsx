/**
 * TerminalManager — top-level container for the terminal surface.
 *
 * Responsibilities:
 *   • render either the card grid or the focused terminal (full-screen)
 *   • host the create dialog
 *   • expose a small imperative API on `window.__terminalManager` for the
 *     KeyboardBridge / headless tests to trigger the create flow
 *
 * The actual keyboard shortcuts and radial switcher live in their own
 * sibling components so this file stays focused on view composition.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Archive,
  BarChart3,
  Bell,
  BellDot,
  History,
  Layers,
  Settings as SettingsIcon,
  Smartphone,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import { CardGrid } from './CardGrid';
import {
  DEFAULT_WARM_SURFACE_LIMIT,
  MAX_MOUNTED_TERMINAL_VIEWS,
  readTerminalSurfacePoolEnabled,
  touchMountedSurfaces,
} from './mountedViewsLru';
import { useOverlayStore } from '../../stores/overlayStore';
import { TerminalView } from './TerminalView';
import { CreateTerminalDialog } from './CreateTerminalDialog';
import { EditTerminalDialog } from './EditTerminalDialog';
import { ProjectSidebar } from './ProjectSidebar';
import { MobileAccessSettings } from '../settings/MobileAccessSettings';
import { ArchivedCardsPanel } from './ArchivedCardsPanel';
import { SessionRecoveryPanel } from './SessionRecoveryPanel';
import { SessionDock } from './SessionDock';
import { StatsPanel } from '../stats/StatsPanel';
import { useStatsAutoRefresh, useStatsSubscription } from '../../stores/statsStore';
import { CommandPalette } from '../palette/CommandPalette';
import type { TerminalCreateOptions, TerminalType } from '../../types/terminal';
import { useSupervisor } from '../../lib/supervisor/useSupervisor';
import {
  git,
  isTauriEnv,
  mobileBridge,
} from '../../lib/tauri-bridge';
import { cardMatchesWorktree } from '../../lib/worktreePaths';
import { clearProjectBranchCache } from './useProjectBranches';
import { clearProjectWorktreeCache } from './useProjectWorktrees';
import { useRightSurfaceStack, type RightSurface } from './useRightSurfaceStack';
import { WorkspacePanel } from '../files/WorkspacePanel';
import {
  WorkspaceDiffView,
  WorkspaceFileEditorView,
} from '../files/WorkspaceContentViews';
import {
  pathBasename,
} from '../files/workspaceContentTabs';
import { WorkbenchView } from '../workbench/WorkbenchView';
import { WorkbenchDetailPanel } from '../workbench/WorkbenchDetailPanel';
import { useWorkbenchModel } from '../workbench/useWorkbenchModel';
import type {
  PrimaryView,
  WorkbenchPanelState,
} from '../../lib/workbench/types';
import {
  WorkspaceContentTabStrip,
} from './WorkspaceContentTabStrip';
import { useWorkspaceContent } from './useWorkspaceContent';
import { useTerminalConfigurationEditor } from './useTerminalConfigurationEditor';
import { useMobileWorkbenchSync } from './useMobileWorkbenchSync';
import {
  useTerminalNavigation,
  type TerminalViewMode,
} from './useTerminalNavigation';
import { useTerminalCommandPalette } from './useTerminalCommandPalette';
import {
  getWorkbenchProjectAttentionCount,
  getWorkbenchWorktreeAttentionCount,
} from '../../lib/workbench/deriveFollowedTerminals';
import {
  getPreloadedManagedStateItem,
  MANAGED_STATE_KEYS,
  writeManagedPreference,
} from '../../lib/managedState';
import { publishMountedTerminalSurfaces } from '../../lib/lifecycle/mountedTerminalSurfaces';

const TERMINAL_TYPES: TerminalType[] = [
  'shell',
  'claude',
  'codex',
  'opencode',
  'gemini',
  'npm',
  'yarn',
  'pnpm',
  'docker',
  'python',
  'node',
  'custom',
];

function normalizeTerminalType(value: string): TerminalType {
  return TERMINAL_TYPES.includes(value as TerminalType) ? (value as TerminalType) : 'custom';
}

export function TerminalManager() {
  const { t } = useTranslation('terminal');
  const cards = useTerminalStore((s) => s.cards);
  const archivedCards = useTerminalStore((s) => s.archivedCards);
  const focusedCardId = useTerminalStore((s) => s.focusedCardId);
  const createCard = useTerminalStore((s) => s.createCard);
  const restoreArchivedCard = useTerminalStore((s) => s.restoreArchivedCard);
  const selectProject = useTerminalStore((s) => s.selectProject);
  const selectWorktree = useTerminalStore((s) => s.selectWorktree);
  const toggleNotificationCentre = useTerminalStore((s) => s.toggleNotificationCentre);
  const unreadCount = useTerminalStore((s) => s.notifications.filter((n) => !n.read).length);
  const selectedProjectPath = useTerminalStore((s) => s.selectedProjectPath);
  const selectedWorktreePath = useTerminalStore((s) => s.selectedWorktreePath);
  const selectedWorktreeLabel = useTerminalStore((s) => s.selectedWorktreeLabel);
  const pushNotification = useTerminalStore((s) => s.pushNotification);
  const dockPinned = useTerminalStore((s) => s.dockPinned);
  const toggleDockPin = useTerminalStore((s) => s.toggleDockPin);

  // AI Supervisor v0.1 — single mount point in the React tree. Hook is a no-op
  // when `supervisorEnabled` is false, so this is safe to call unconditionally.
  useSupervisor();

  const selectedProjectName = useMemo(() => {
    if (!selectedProjectPath) return null;
    const card =
      cards.find((c) => c.projectPath === selectedProjectPath) ??
      archivedCards.find((c) => c.projectPath === selectedProjectPath);
    return card?.projectName ?? selectedProjectPath;
  }, [archivedCards, cards, selectedProjectPath]);

  const selectedProjectArchivedCards = useMemo(() => {
    if (!selectedProjectPath) return [];
    return archivedCards
      .filter(
        (card) =>
          card.projectPath === selectedProjectPath &&
          cardMatchesWorktree(card, selectedWorktreePath),
      )
      .sort((a, b) => b.archivedAt - a.archivedAt);
  }, [archivedCards, selectedProjectPath, selectedWorktreePath]);

  // Cards visible with the current project/worktree filter applied.
  const visibleCards = useMemo(
    () =>
      selectedProjectPath
        ? cards.filter(
            (c) =>
              c.projectPath === selectedProjectPath &&
              cardMatchesWorktree(c, selectedWorktreePath),
          )
        : cards,
    [cards, selectedProjectPath, selectedWorktreePath],
  );

  const [viewMode, setViewMode] = useState<TerminalViewMode>('grid');
  const [primaryView, setPrimaryView] = useState<PrimaryView>('workbench');
  const [workbenchPanel, setWorkbenchPanel] = useState<WorkbenchPanelState | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768);
  const [isSidebarCompact, setIsSidebarCompact] = useState(
    typeof window !== 'undefined' && window.innerWidth >= 768 && window.innerWidth < 1180,
  );

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      setIsSidebarCompact(window.innerWidth >= 768 && window.innerWidth < 1180);
      if (!mobile) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const [createOpen, setCreateOpen] = useState(false);
  const [mobileViewActive, setMobileViewActive] = useState(false);
  const {
    allProjectsWorkbenchModel,
    followCards,
    followedCardIds,
    unfollowCard,
    workbenchModel,
  } = useWorkbenchModel({
    cards,
    selectedProjectPath,
    selectedWorktreePath,
  });
  useStatsSubscription();
  useStatsAutoRefresh();

  // Shortcut hint: dismissible, persisted across sessions.
  const [hintDismissed, setHintDismissed] = useState<boolean>(
    () => getPreloadedManagedStateItem(MANAGED_STATE_KEYS.shortcutHintDismissed) === '1',
  );
  const dismissHint = useCallback(() => {
    setHintDismissed(true);
    writeManagedPreference(MANAGED_STATE_KEYS.shortcutHintDismissed, '1');
  }, []);

  // Card ids whose TerminalView is kept mounted, in LRU order (oldest first).
  // Surface pool (Batch 2): keep every actually-visible surface (main focus +
  // float) plus one hidden warm view. Legacy fixed cap of
  // MAX_MOUNTED_TERMINAL_VIEWS remains available via feature-flag rollback.
  // Evicted views unmount their xterm while the PTY survives in Rust
  // (`preservePtyOnUnmount`); re-focusing replays history via attachSnapshot.
  const mountedIdsRef = useRef<string[]>([]);
  const [, bumpRender] = useState(0);

  const mountCardInBackground = useCallback((cardId: string) => {
    const current = mountedIdsRef.current;
    const wasMounted = current.includes(cardId);
    // Read focus/float from stores (not render scope) so this callback stays
    // referentially stable for the mobile bridge subscription effect.
    const focusedId = useTerminalStore.getState().focusedCardId;
    const floatCardId = useOverlayStore.getState().floatCardId;
    const floatOpen = useOverlayStore.getState().floatOpen;
    const poolEnabled = readTerminalSurfacePoolEnabled();
    const visibleIds = [
      focusedId,
      floatOpen ? floatCardId : null,
    ].filter((id): id is string => Boolean(id));
    const { next, evicted } = touchMountedSurfaces(current, cardId, {
      visibleIds,
      poolEnabled,
      warmLimit: DEFAULT_WARM_SURFACE_LIMIT,
      legacyCap: MAX_MOUNTED_TERMINAL_VIEWS,
    });
    mountedIdsRef.current = next;
    // Read-only sampling mirror for tools/webview-memory-lifecycle.
    publishMountedTerminalSurfaces({
      mountedCardIds: next,
      focusedCardId: focusedId,
      floatCardId: floatOpen ? floatCardId : null,
      maxMountedTerminalViews: poolEnabled
        ? visibleIds.length + DEFAULT_WARM_SURFACE_LIMIT
        : MAX_MOUNTED_TERMINAL_VIEWS,
      terminalSurfacePoolEnabled: poolEnabled,
    });
    // Re-render only when membership changed; pure LRU reordering does not
    // affect which TerminalViews render.
    if (!wasMounted || evicted.length > 0) bumpRender((n) => n + 1);
  }, []);

  const focusedCard = useMemo(
    () => (focusedCardId ? cards.find((c) => c.id === focusedCardId) : undefined),
    [focusedCardId, cards],
  );
  const primaryPageVisible =
    (viewMode === 'grid' || !focusedCard) && !mobileViewActive;
  const workbenchVisible = primaryPageVisible && primaryView === 'workbench';
  const terminalsVisible = primaryPageVisible && primaryView === 'terminals';

  // Live working directory of the focused card. Without command-block shell
  // integration, this stays anchored to the card's worktree/project path.
  const focusedCwd = useMemo(() => {
    if (!focusedCardId) return null;
    const cwd = (focusedCard?.worktreePath || focusedCard?.projectPath || '').trim();
    return cwd || null;
  }, [focusedCardId, focusedCard]);

  const sessionDockAvailable = viewMode === 'focus' && Boolean(focusedCard);

  const isRightSurfaceAvailable = useCallback(
    (surface: RightSurface) => {
      switch (surface) {
        case 'stats':
          return true;
        case 'sessionRecovery':
          return true;
        case 'archive':
          return Boolean(selectedProjectPath && selectedProjectName);
        case 'sessionDock':
          return sessionDockAvailable;
        case 'workbench':
          return Boolean(workbenchPanel && primaryView === 'workbench' && primaryPageVisible);
      }
    },
    [
      primaryPageVisible,
      primaryView,
      selectedProjectName,
      selectedProjectPath,
      sessionDockAvailable,
      workbenchPanel,
    ],
  );

  const {
    activeRightSurface,
    openRightSurface,
    closeRightSurface,
    toggleRightSurface,
  } = useRightSurfaceStack(isRightSurfaceAvailable);

  useEffect(() => {
    closeRightSurface('archive');
  }, [closeRightSurface, selectedProjectPath]);

  useEffect(() => {
    if (!sessionDockAvailable) {
      closeRightSurface('sessionDock');
    }
  }, [closeRightSurface, sessionDockAvailable]);

  useEffect(() => {
    if (dockPinned && sessionDockAvailable) {
      openRightSurface('sessionDock');
    } else if (!dockPinned) {
      closeRightSurface('sessionDock');
    }
  }, [closeRightSurface, dockPinned, openRightSurface, sessionDockAvailable]);

  useEffect(() => {
    if (!workbenchPanel || primaryView !== 'workbench' || !primaryPageVisible) {
      closeRightSurface('workbench');
    }
  }, [
    closeRightSurface,
    primaryPageVisible,
    primaryView,
    workbenchPanel,
  ]);

  // Auxiliary right-side surfaces share the fixed workspace rail. The most
  // recently opened surface wins, and closing it restores the workspace rail.
  const toggleRightPanel = useCallback(
    (panel: 'stats' | 'archive' | 'sessionRecovery') => {
      toggleRightSurface(panel);
    },
    [toggleRightSurface],
  );

  const workspaceRailVisible = viewMode === 'focus' && !!focusedCwd;
  const workspacePanelVisible = workspaceRailVisible && !activeRightSurface;
  const statsPanelVisible = activeRightSurface === 'stats';
  const archivePanelVisible =
    activeRightSurface === 'archive' && !!selectedProjectPath && !!selectedProjectName;
  const sessionRecoveryPanelVisible = activeRightSurface === 'sessionRecovery';
  const sessionDockPanelVisible = activeRightSurface === 'sessionDock' && sessionDockAvailable;
  const workbenchPanelVisible =
    activeRightSurface === 'workbench' &&
    Boolean(workbenchPanel) &&
    primaryView === 'workbench' &&
    primaryPageVisible;
  const auxiliaryRightPanelOpen =
    statsPanelVisible ||
    archivePanelVisible ||
    sessionDockPanelVisible ||
    sessionRecoveryPanelVisible ||
    workbenchPanelVisible;
  const rightPanelOpen =
    workspaceRailVisible ||
    auxiliaryRightPanelOpen;
  const statsOpen = activeRightSurface === 'stats';
  const archiveOpen = activeRightSurface === 'archive';
  const sessionRecoveryOpen = activeRightSurface === 'sessionRecovery';
  const {
    workspaceContentTabs,
    activeContentTabId,
    dirtyWorkspaceTabIds,
    workspacePanelState,
    terminalContentActive,
    activeWorkspaceFilePath,
    activeWorkspaceDiffPath,
    mountedWorkspaceContentViews,
    setActiveContentTabId,
    openWorkspaceFileForCard,
    openWorkspaceFile,
    openWorkspaceDiff,
    markWorkspaceTabDirty,
    closeWorkspaceTab,
    closeAllWorkspaceTabs,
    closeOtherWorkspaceTabs,
    requestRemoveCard,
    requestArchiveCard,
    requestCardWorkspaceReset,
    handleWorkspacePanelStateChange,
    activateTerminalForCard,
  } = useWorkspaceContent({
    cards,
    focusedCardId,
    t,
  });
  const workspaceTabsVisible =
    viewMode === 'focus' && !!focusedCard && workspaceContentTabs.length > 0;
  const mobileBridgeSyncEnabled = useMobileWorkbenchSync({
    cards,
    mobileWorkbenchModel: allProjectsWorkbenchModel,
  });

  // Mark the focused card as most-recently-used (mounting it if needed and
  // evicting the LRU view when over cap). The focused card itself is the
  // protected id inside touchMountedId, so it can never be evicted.
  useEffect(() => {
    if (!focusedCardId) return;
    mountCardInBackground(focusedCardId);
  }, [focusedCardId, mountCardInBackground]);

  const {
    focusMountedCard,
    handleBackToGrid,
    handleCloseWorkbenchPanel,
    handleOpenMobileAccess,
    handleOpenTerminal,
    handleOpenWorkbenchPanel,
    handleSelectPrimaryView,
    handleSelectSessionDockCard,
  } = useTerminalNavigation({
    cards,
    focusedCard,
    focusedCardId,
    primaryView,
    terminalsVisible,
    activateTerminalForCard,
    closeRightSurface,
    mountCardInBackground,
    openRightSurface,
    setMobileViewActive,
    setPrimaryView,
    setSidebarOpen,
    setViewMode,
    setWorkbenchPanel,
  });
  const {
    editingCard,
    pendingConfiguration: pendingEditingConfiguration,
    terminalRevealTokens,
    openEditor: openTerminalEditor,
    closeEditor: closeTerminalEditor,
    submit: submitTerminalConfiguration,
    discardPending: discardPendingTerminalConfiguration,
    locateConflict: locateTerminalConfigurationConflict,
  } = useTerminalConfigurationEditor({
    t,
    requestCardWorkspaceReset,
    activateTerminalForCard,
    openTerminal: handleOpenTerminal,
  });
  const {
    closePalette,
    handleOpenSettings,
    paletteEntries,
    paletteInitialGroup,
    paletteOpen,
  } = useTerminalCommandPalette({
    cards,
    focusedCardId,
    requestArchiveCard,
    requestRemoveCard,
    setCreateOpen,
    setViewMode,
  });

  useEffect(() => {
    if (!mobileBridgeSyncEnabled) return;
    let cancelled = false;
    const unsubscribers: Array<() => void> = [];

    const resolveSpawn = (result: Parameters<typeof mobileBridge.resolveSpawn>[0]) => {
      void mobileBridge.resolveSpawn(result).catch((error) => {
        console.warn('[MobileBridge] failed to resolve spawn', error);
      });
    };
    const resolveActivate = (result: Parameters<typeof mobileBridge.resolveActivate>[0]) => {
      void mobileBridge.resolveActivate(result).catch((error) => {
        console.warn('[MobileBridge] failed to resolve activate', error);
      });
    };
    const resolveClose = (result: Parameters<typeof mobileBridge.resolveClose>[0]) => {
      void mobileBridge.resolveClose(result).catch((error) => {
        console.warn('[MobileBridge] failed to resolve close', error);
      });
    };
    const resolveRename = (result: Parameters<typeof mobileBridge.resolveRenameCard>[0]) => {
      void mobileBridge.resolveRenameCard(result).catch((error) => {
        console.warn('[MobileBridge] failed to resolve rename', error);
      });
    };

    void Promise.all([
      mobileBridge.onSpawnCard((payload) => {
        const projectPath = payload.projectPath.trim();
        if (!projectPath) {
          resolveSpawn({
            requestId: payload.requestId,
            ok: false,
            errorCode: 'invalid_project_path',
            message: 'Project path is required.',
          });
          return;
        }

        const cardId = useTerminalStore.getState().createCard({
          projectPath,
          projectName: pathBasename(projectPath),
          terminalType: normalizeTerminalType(payload.terminalType),
          command: payload.command?.trim() || undefined,
        });
        mountCardInBackground(cardId);
        resolveSpawn({ requestId: payload.requestId, ok: true, cardId });
      }),
      mobileBridge.onActivateCard((payload) => {
        const card = useTerminalStore
          .getState()
          .cards
          .find((candidate) => candidate.id === payload.cardId);
        if (!card) {
          resolveActivate({
            requestId: payload.requestId,
            ok: false,
            cardId: payload.cardId,
            errorCode: 'card_not_found',
            message: 'Card not found.',
          });
          return;
        }

        mountCardInBackground(card.id);
        resolveActivate({ requestId: payload.requestId, ok: true, cardId: card.id });
      }),
      mobileBridge.onRemoveCard(async (payload) => {
        const exists = useTerminalStore
          .getState()
          .cards
          .some((candidate) => candidate.id === payload.cardId);
        if (!exists) {
          resolveClose({
            requestId: payload.requestId,
            ok: false,
            cardId: payload.cardId,
            errorCode: 'card_not_found',
            message: 'Card not found.',
          });
          return;
        }

        const removed = await requestRemoveCard(payload.cardId);
        if (!removed) {
          resolveClose({
            requestId: payload.requestId,
            ok: false,
            cardId: payload.cardId,
            errorCode: 'user_cancelled',
            message: 'Close cancelled.',
          });
          return;
        }
        resolveClose({ requestId: payload.requestId, ok: true, cardId: payload.cardId });
      }),
      mobileBridge.onRenameCard((payload) => {
        const exists = useTerminalStore
          .getState()
          .cards
          .some((candidate) => candidate.id === payload.cardId);
        if (!exists) {
          resolveRename({
            requestId: payload.requestId,
            ok: false,
            cardId: payload.cardId,
            errorCode: 'card_not_found',
            message: 'Card not found.',
          });
          return;
        }

        useTerminalStore.getState().renameCard(payload.cardId, payload.projectName);
        resolveRename({ requestId: payload.requestId, ok: true, cardId: payload.cardId });
      }),
    ])
      .then((nextUnsubscribers) => {
        if (cancelled) {
          nextUnsubscribers.forEach((unsubscribe) => unsubscribe());
        } else {
          unsubscribers.push(...nextUnsubscribers);
        }
      })
      .catch((error) => {
        console.warn('[MobileBridge] failed to subscribe to mobile requests', error);
      });

    return () => {
      cancelled = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [mobileBridgeSyncEnabled, mountCardInBackground, requestRemoveCard]);

  // Drop mount entries for cards that no longer exist (user removed them).
  useEffect(() => {
    const ids = new Set(cards.map((c) => c.id));
    const next = mountedIdsRef.current.filter((id) => ids.has(id));
    if (next.length !== mountedIdsRef.current.length) {
      mountedIdsRef.current = next;
      const poolEnabled = readTerminalSurfacePoolEnabled();
      publishMountedTerminalSurfaces({
        mountedCardIds: next,
        focusedCardId: useTerminalStore.getState().focusedCardId,
        floatCardId: useOverlayStore.getState().floatOpen
          ? useOverlayStore.getState().floatCardId
          : null,
        maxMountedTerminalViews: poolEnabled
          ? next.length
          : MAX_MOUNTED_TERMINAL_VIEWS,
        terminalSurfacePoolEnabled: poolEnabled,
      });
      bumpRender((n) => n + 1);
    }
  }, [cards]);

  // When float opens/closes or changes card, re-protect visible surfaces.
  const floatCardId = useOverlayStore((s) => s.floatCardId);
  const floatOpen = useOverlayStore((s) => s.floatOpen);
  useEffect(() => {
    if (!floatOpen || !floatCardId) return;
    mountCardInBackground(floatCardId);
  }, [floatCardId, floatOpen, mountCardInBackground]);

  const sessionDockVisible = sessionDockPanelVisible;

  const handleCloseSessionDock = useCallback(() => {
    if (dockPinned) toggleDockPin();
    closeRightSurface('sessionDock');
  }, [closeRightSurface, dockPinned, toggleDockPin]);

  const handleRestoreArchivedCard = useCallback(
    (cardId: string) => {
      restoreArchivedCard(cardId);
    },
    [restoreArchivedCard],
  );

  const handleCreate = useCallback(
    (options: TerminalCreateOptions) => {
      const id = createCard(options);
      if (options.worktreePath) {
        selectWorktree(options.projectPath, options.worktreePath, options.branchLabel);
      } else {
        selectProject(options.projectPath);
      }
      setCreateOpen(false);
      focusMountedCard(id);
    },
    [createCard, focusMountedCard, selectProject, selectWorktree],
  );

  const handleGridCreateTerminal = useCallback(
    (options?: TerminalCreateOptions) => {
      if (options) {
        handleCreate(options);
        return;
      }
      setCreateOpen(true);
    },
    [handleCreate],
  );

  const handleCreateWorktreeTerminal = useCallback(
    async (request: { projectPath: string; branch: string; branchLabel: string }) => {
      try {
        const worktree = await git.worktrees.add(request.projectPath, request.branch);
        clearProjectBranchCache();
        clearProjectWorktreeCache();
        const projectName =
          cards.find((card) => card.projectPath === request.projectPath)?.projectName ??
          selectedProjectName ??
          pathBasename(request.projectPath);
        const id = createCard({
          projectName,
          projectPath: request.projectPath,
          worktreePath: worktree.path,
          branchLabel: request.branchLabel,
          terminalType: 'shell',
        });
        selectWorktree(request.projectPath, worktree.path, request.branchLabel);
        focusMountedCard(id);
        pushNotification({
          cardId: 'system:worktrees',
          kind: 'completed',
          title: t('sidebar.createWorktree', {
            defaultValue: 'Create worktree and open terminal',
          }),
          body: t('sidebar.worktreeCreated', {
            path: worktree.path,
            defaultValue: 'Created worktree {{path}}.',
          }),
        });
      } catch (err) {
        pushNotification({
          cardId: 'system:worktrees',
          kind: 'failed',
          title: t('sidebar.worktreeCreateFailed', {
            defaultValue: 'Failed to create worktree',
          }),
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [cards, createCard, focusMountedCard, pushNotification, selectWorktree, selectedProjectName, t],
  );

  const recentProjects = useMemo(
    () => cards.map((c) => ({ path: c.projectPath, name: c.projectName })),
    [cards],
  );
  const workbenchScopeLabel = selectedProjectName
    ? [selectedProjectName, selectedWorktreeLabel].filter(Boolean).join(' · ')
    : null;
  const getProjectAttentionCount = useCallback(
    (projectPath: string) =>
      getWorkbenchProjectAttentionCount(
        allProjectsWorkbenchModel.scopeAttentionCounts,
        projectPath,
      ),
    [allProjectsWorkbenchModel.scopeAttentionCounts],
  );
  const getWorktreeAttentionCount = useCallback(
    (projectPath: string, worktreePath: string) =>
      getWorkbenchWorktreeAttentionCount(
        allProjectsWorkbenchModel.scopeAttentionCounts,
        projectPath,
        worktreePath,
      ),
    [allProjectsWorkbenchModel.scopeAttentionCounts],
  );

  return (
    <div className="relative flex h-full w-full bg-mesh overflow-hidden">
      <div className="absolute inset-0 bg-grid pointer-events-none" />

      {/* Sidebar - Desktop: fixed, Mobile: drawer */}
      <div className={[
        'z-40 transition-all duration-300 ease-in-out md:relative md:translate-x-0',
        isMobile ? 'absolute inset-y-0 left-0 shadow-2xl' : '',
        isMobile && !sidebarOpen ? '-translate-x-full' : 'translate-x-0'
      ].join(' ')}>
        <ProjectSidebar
          onCloseMobile={() => setSidebarOpen(false)}
          onCreateTerminal={() => setCreateOpen(true)}
          primaryView={primaryView}
          onSelectPrimaryView={handleSelectPrimaryView}
          attentionCount={allProjectsWorkbenchModel.summary.attention}
          getProjectAttentionCount={getProjectAttentionCount}
          getWorktreeAttentionCount={getWorktreeAttentionCount}
          compact={isSidebarCompact}
          isMobile={isMobile}
          onExitMobileView={() => setMobileViewActive(false)}
        />
      </div>

      {/* Mobile Sidebar Backdrop */}
      {isMobile && sidebarOpen && (
        <div
          className="absolute inset-0 z-30 bg-background/60 backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className="relative flex min-w-0 flex-1 flex-col glass-reflection">
      {/* Top bar */}
      <div className="flex h-12 shrink-0 items-center justify-between etched-border-b bg-background/60 px-4 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-2">
          {isMobile && (
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="mr-1 rounded-md p-1.5 hover:bg-accent"
            >
              <Layers className="h-4 w-4" />
            </button>
          )}
          <div className="text-sm font-semibold shrink-0 md:block hidden">{t('app.title')}</div>
          {selectedProjectName && (
            <>
              <span className="text-muted-foreground md:inline hidden">/</span>
              <span
                className="truncate rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
                title={selectedProjectPath ?? undefined}
              >
                {selectedProjectName}
              </span>
            </>
          )}
          {selectedProjectName && selectedWorktreeLabel && (
            <>
              <span className="text-muted-foreground md:inline hidden">/</span>
              <span
                className="truncate rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-foreground/80"
                title={selectedWorktreePath ?? undefined}
              >
                {selectedWorktreeLabel}
              </span>
            </>
          )}
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground sm:inline hidden">
            {t('app.count', { visible: visibleCards.length, total: cards.length, count: cards.length })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {selectedProjectPath && selectedProjectArchivedCards.length > 0 && (
            <button
              type="button"
              onClick={() => toggleRightPanel('archive')}
              title={t('archive.openTitle')}
              className={[
                'relative inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium',
                archiveOpen
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-accent hover:text-accent-foreground',
              ].join(' ')}
            >
              <Archive className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('archive.open')}</span>
              <span className="flex min-h-[14px] min-w-[14px] items-center justify-center rounded-full bg-muted px-1 text-[11px] font-bold text-muted-foreground">
                {selectedProjectArchivedCards.length > 99
                  ? '99+'
                  : selectedProjectArchivedCards.length}
              </span>
            </button>
          )}
          {isTauriEnv() && (
            <button
              type="button"
              onClick={() => toggleRightPanel('sessionRecovery')}
              title={t('sessionRecovery.openTitle')}
              className={[
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium',
                sessionRecoveryOpen
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-accent hover:text-accent-foreground',
              ].join(' ')}
            >
              <History className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('sessionRecovery.open')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleOpenMobileAccess}
            title={t('sidebar.mobileAccess', { defaultValue: 'Mobile access' })}
            aria-pressed={mobileViewActive}
            className={[
              'rounded-md p-1.5',
              mobileViewActive
                ? 'bg-primary/10 text-primary'
                : 'hover:bg-accent hover:text-accent-foreground',
            ].join(' ')}
          >
            <Smartphone className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => toggleRightPanel('stats')}
            title={t('stats.toggle', { defaultValue: 'Token usage' })}
            className={[
              'rounded-md p-1.5',
              statsOpen
                ? 'bg-primary/10 text-primary'
                : 'hover:bg-accent hover:text-accent-foreground',
            ].join(' ')}
          >
            <BarChart3 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => handleOpenSettings('shortcuts')}
            title={t('app.settingsTitle')}
            className="rounded-md p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => toggleNotificationCentre()}
            title={t('app.notificationsTitle')}
            className="relative rounded-md p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            {unreadCount > 0 ? (
              <BellDot className="h-4 w-4 text-warning" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            {unreadCount > 0 && (
              <span className="absolute right-0.5 top-0.5 flex min-h-[14px] min-w-[14px] items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-bold text-white">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Terminal area + right-side panel form a horizontal flex row, so an
          open panel becomes its own column that squeezes the terminal (not a
          floating overlay) and stays below the top bar — never covering the
          shortcut buttons. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {workspaceTabsVisible && (
          <WorkspaceContentTabStrip
            tabs={workspaceContentTabs}
            activeTabId={activeContentTabId}
            dirtyTabIds={dirtyWorkspaceTabIds}
            terminalLabel={t('codexChat.terminal', { defaultValue: 'Terminal' })}
            closeLabel={t('common.close', { defaultValue: 'Close' })}
            closeCurrentLabel={t('workspace.closeCurrentTab', { defaultValue: '关闭当前' })}
            closeAllLabel={t('workspace.closeAllTabs', { defaultValue: '关闭所有' })}
            closeOthersLabel={t('workspace.closeOtherTabs', { defaultValue: '关闭除当前' })}
            onActivate={setActiveContentTabId}
            onClose={(tabId) => void closeWorkspaceTab(tabId)}
            onCloseAll={() => void closeAllWorkspaceTabs()}
            onCloseOthers={(tabId) => void closeOtherWorkspaceTabs(tabId)}
          />
        )}

      {/* Main body — workbench, card grid, and all ever-mounted terminal views share the same
          container; only the active focused view is visible. This is what keeps
          the PTY alive across navigation so CLIs don't re-initialise. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* Workbench layer — deterministic projections only, never xterm. */}
        <motion.div
          animate={{ opacity: workbenchVisible ? 1 : 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          aria-hidden={!workbenchVisible}
          style={{ visibility: workbenchVisible ? 'visible' : 'hidden' }}
          className={[
            'absolute inset-0',
            workbenchVisible ? '' : 'pointer-events-none',
          ].join(' ')}
        >
          <WorkbenchView
            cards={workbenchModel.filteredCards}
            allCards={cards}
            attentionItems={workbenchModel.attentionItems}
            stalledItems={workbenchModel.stalledItems}
            followedCards={workbenchModel.followedCards}
            followedCardIds={followedCardIds}
            groups={workbenchModel.groups}
            projectOverviews={allProjectsWorkbenchModel.projectOverviews}
            summary={workbenchModel.summary}
            now={workbenchModel.now}
            scopeLabel={workbenchScopeLabel}
            selectedProjectPath={selectedProjectPath}
            selectedWorktreePath={selectedWorktreePath}
            onOpenTerminal={handleOpenTerminal}
            onOpenAttention={(item) =>
              handleOpenWorkbenchPanel({
                kind: 'attention',
                attentionId: item.id,
              })
            }
            onOpenGroup={(group) =>
              handleOpenWorkbenchPanel({ kind: 'group', groupId: group.id })
            }
            onOpenRules={() => handleOpenWorkbenchPanel({ kind: 'rules' })}
            onNavigateTerminals={() => handleSelectPrimaryView('terminals')}
            onCreateTerminal={() => setCreateOpen(true)}
            onFollowCards={followCards}
            onUnfollowCard={unfollowCard}
            onSelectProject={(projectPath) => selectProject(projectPath)}
            onShowAllProjects={() => selectProject(null)}
          />
        </motion.div>

        {/* Existing CardGrid is the complete "All terminals" page. */}
        <motion.div
          animate={{ opacity: terminalsVisible ? 1 : 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          aria-hidden={!terminalsVisible}
          style={{ visibility: terminalsVisible ? 'visible' : 'hidden' }}
          className={[
            'absolute inset-0',
            terminalsVisible
              ? ''
              : 'pointer-events-none',
          ].join(' ')}
        >
          <CardGrid
            onCreateTerminal={handleGridCreateTerminal}
            onCreateWorktreeTerminal={handleCreateWorktreeTerminal}
            onOpenTerminal={handleOpenTerminal}
            onEditTerminal={openTerminalEditor}
            onRemoveCard={requestRemoveCard}
            onArchiveCard={requestArchiveCard}
          />
        </motion.div>

        {/* Mobile-access view layer — replaces the grid when "移动端" is selected. */}
        {mobileViewActive && (
          <div
            data-testid="mobile-access-view"
            className="absolute inset-0 overflow-y-auto bg-background/60 backdrop-blur-sm"
          >
            <div className="min-h-full w-full px-4 py-4 sm:px-6 lg:px-8">
              <MobileAccessSettings />
            </div>
          </div>
        )}

        {/* Persistent terminal views */}
        {cards
          .filter((c) => mountedIdsRef.current.includes(c.id))
          .map((c) => {
            const isCurrent =
              viewMode === 'focus' && focusedCardId === c.id && terminalContentActive;
            return (
              <div
                key={c.id}
                aria-hidden={!isCurrent}
                style={{ visibility: isCurrent ? 'visible' : 'hidden' }}
                className={[
                  'absolute inset-0 transition-opacity duration-150 ease-out',
                  isCurrent
                    ? 'opacity-100 pointer-events-auto'
                    : 'opacity-0 pointer-events-none',
                ].join(' ')}
              >
                <TerminalView
                  card={c}
                  active={isCurrent}
                  onBack={handleBackToGrid}
                  onRemoveCard={requestRemoveCard}
                  onArchiveCard={requestArchiveCard}
                  onEdit={openTerminalEditor}
                  revealTerminalToken={terminalRevealTokens[c.id] ?? 0}
                />
              </div>
            );
          })}

        {mountedWorkspaceContentViews.map(({ cardId, tab }) => {
          const isCurrent =
            viewMode === 'focus' &&
            focusedCardId === cardId &&
            activeContentTabId === tab.id;
          return (
            <div
              key={`${cardId}\u001f${tab.id}`}
              aria-hidden={!isCurrent}
              style={{ visibility: isCurrent ? 'visible' : 'hidden' }}
              className={[
                'absolute inset-0 transition-opacity duration-150 ease-out',
                isCurrent
                  ? 'opacity-100 pointer-events-auto'
                  : 'opacity-0 pointer-events-none',
              ].join(' ')}
            >
              {tab.kind === 'file' ? (
                <WorkspaceFileEditorView
                  rootPath={tab.rootPath}
                  path={tab.path}
                  active={isCurrent}
                  onDirtyChange={(dirty) => markWorkspaceTabDirty(cardId, tab.id, dirty)}
                />
              ) : (
                <WorkspaceDiffView
                  change={tab.change}
                  active={isCurrent}
                  onOpenFile={(rootPath, entry) =>
                    openWorkspaceFileForCard(cardId, rootPath, entry)
                  }
                  onDirtyChange={(dirty) => markWorkspaceTabDirty(cardId, tab.id, dirty)}
                />
              )}
            </div>
          );
        })}

      </div>
      </div>

      {/* Right-side panel column — mutually exclusive; lives inside the
          horizontal flex so it squeezes the terminal and stays within the
          terminal-area height, below the top bar (never covers the toolbar). */}
      {rightPanelOpen && (
        <aside
          className={[
            'flex flex-col border-l border-border bg-background/95 backdrop-blur-2xl shadow-studio',
            isMobile
              ? 'absolute inset-y-0 right-0 z-50 w-full max-w-sm'
              : 'w-80 shrink-0',
          ].join(' ')}
        >
          {workspacePanelVisible && focusedCwd && (
            <WorkspacePanel
              rootCwd={focusedCwd}
              state={workspacePanelState}
              activeFilePath={activeWorkspaceFilePath}
              activeDiffPath={activeWorkspaceDiffPath}
              onStateChange={handleWorkspacePanelStateChange}
              onOpenFile={openWorkspaceFile}
              onOpenDiff={openWorkspaceDiff}
            />
          )}
          {statsPanelVisible && <StatsPanel onClose={() => closeRightSurface('stats')} />}
          {sessionRecoveryPanelVisible && (
            <SessionRecoveryPanel onClose={() => closeRightSurface('sessionRecovery')} />
          )}
          {archivePanelVisible && selectedProjectName && (
            <ArchivedCardsPanel
              projectName={selectedProjectName}
              cards={selectedProjectArchivedCards}
              onRestore={handleRestoreArchivedCard}
              onClose={() => closeRightSurface('archive')}
            />
          )}
          {sessionDockVisible && (
            <SessionDock
              visible={sessionDockVisible}
              variant="panel"
              onClose={handleCloseSessionDock}
              onSelectCard={handleSelectSessionDockCard}
            />
          )}
          {workbenchPanelVisible && workbenchPanel && (
            <WorkbenchDetailPanel
              panel={workbenchPanel}
              attentionItems={workbenchModel.attentionItems}
              groups={workbenchModel.groups}
              cards={workbenchModel.filteredCards}
              notifications={workbenchModel.notifications}
              now={workbenchModel.now}
              onOpenTerminal={handleOpenTerminal}
              onClose={handleCloseWorkbenchPanel}
            />
          )}
        </aside>
      )}
      </div>

      {/* Shortcut hint — dismissible. Anchored to the LEFT so it can't
          overlap with the right-side panel, and hidden whenever a modal/panel
          is open so it never sits on top of overlay UI. */}
      {cards.length > 0 &&
        terminalContentActive &&
        (viewMode === 'focus' || primaryView === 'terminals') &&
        !hintDismissed &&
        !auxiliaryRightPanelOpen &&
        !sessionDockVisible &&
        !paletteOpen && (
        <div
          className={[
            'absolute left-3 z-10 flex select-none items-center gap-2 rounded-md border border-border bg-background/80 py-1 pl-2.5 pr-1 text-[11px] text-muted-foreground backdrop-blur',
            viewMode === 'focus' && focusedCard ? 'bottom-10' : 'bottom-3',
          ].join(' ')}
        >
          <span>
            <span className="font-mono">⌘/Ctrl+`</span> {t('app.shortcutHint').split(' · ')[0]} ·{' '}
            <span className="font-mono">⌘/Ctrl+Tab</span> {t('app.shortcutHint').split(' · ')[1]} ·{' '}
            <span className="font-mono">⌘/Ctrl+1-9</span> {t('app.shortcutHint').split(' · ')[2]}
          </span>
          <button
            type="button"
            data-testid="shortcut-hint-dismiss"
            onClick={dismissHint}
            title={t('common.close', { defaultValue: 'Close' })}
            aria-label={t('common.close', { defaultValue: 'Close' })}
            className="rounded p-0.5 hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}


      {/* Command palette (Cmd/Ctrl+K) */}
      <CommandPalette
        open={paletteOpen}
        entries={paletteEntries}
        initialGroup={paletteInitialGroup}
        onClose={closePalette}
      />

      {/* Create dialog */}
      <CreateTerminalDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
        recentProjects={recentProjects}
      />
      <EditTerminalDialog
        open={Boolean(editingCard)}
        card={editingCard}
        pendingConfiguration={pendingEditingConfiguration}
        onClose={closeTerminalEditor}
        onSubmit={submitTerminalConfiguration}
        onDiscardPending={discardPendingTerminalConfiguration}
        onLocateConflict={locateTerminalConfigurationConflict}
      />

      </div>
    </div>
  );
}
