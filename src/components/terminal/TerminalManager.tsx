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
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import {
  Archive,
  BarChart3,
  Bell,
  BellDot,
  FileText,
  GitCompare,
  History,
  Layers,
  Settings as SettingsIcon,
  Smartphone,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import { CardGrid } from './CardGrid';
import { MAX_MOUNTED_TERMINAL_VIEWS, touchMountedId } from './mountedViewsLru';
import { TerminalView } from './TerminalView';
import { CreateTerminalDialog } from './CreateTerminalDialog';
import { ProjectSidebar } from './ProjectSidebar';
import { MobileAccessSettings } from '../settings/MobileAccessSettings';
import { ArchivedCardsPanel } from './ArchivedCardsPanel';
import { SessionRecoveryPanel } from './SessionRecoveryPanel';
import { SessionDock } from './SessionDock';
import { AttentionDot } from './AttentionDot';
import { StatsPanel } from '../stats/StatsPanel';
import { useStatsAutoRefresh, useStatsSubscription } from '../../stores/statsStore';
import { CommandPalette } from '../palette/CommandPalette';
import { buildCommandRegistry, type CommandGroup } from '../palette/commandRegistry';
import type { TerminalCard, TerminalCreateOptions, TerminalType } from '../../types/terminal';
import { useSupervisor } from '../../lib/supervisor/useSupervisor';
import {
  git,
  isTauriEnv,
  mobileBridge,
  mobileBridgeHasSubscribers,
  type GitStatusEntry,
} from '../../lib/tauri-bridge';
import { openSettingsWindow, type SettingsTab } from '../../lib/settingsWindow';
import { confirmDialog } from '../../lib/nativeDialog';
import { cardToMobileMeta } from '../../mobile/bridge/cardMeta';
import {
  buildMobileWorkbenchProjection,
  notificationsToMobile,
} from '../../mobile/bridge/workbenchProjection';
import { cardMatchesWorktree } from '../../lib/worktreePaths';
import { clearProjectBranchCache } from './useProjectBranches';
import { clearProjectWorktreeCache } from './useProjectWorktrees';
import { useRightSurfaceStack, type RightSurface } from './useRightSurfaceStack';
import { WorkspacePanel, type WorkspacePanelState } from '../files/WorkspacePanel';
import {
  WorkspaceDiffView,
  WorkspaceFileEditorView,
} from '../files/WorkspaceContentViews';
import {
  pathBasename,
  workspaceDiffTabId,
  workspaceFileTabId,
} from '../files/workspaceContentTabs';
import type { DirEntry } from '../files/fileMeta';
import { WorkbenchView } from '../workbench/WorkbenchView';
import { WorkbenchDetailPanel } from '../workbench/WorkbenchDetailPanel';
import { useWorkbenchModel } from '../workbench/useWorkbenchModel';
import type {
  PrimaryView,
  WorkbenchPanelState,
} from '../../lib/workbench/types';

type ViewMode = 'grid' | 'focus';
type WorkspaceContentTab =
  | {
      id: string;
      kind: 'file';
      rootPath: string;
      path: string;
      title: string;
    }
  | {
      id: string;
      kind: 'diff';
      change: GitStatusEntry;
      title: string;
    };
interface WorkspaceContentState {
  tabs: WorkspaceContentTab[];
  activeTabId: string;
  dirtyTabIds: Record<string, boolean>;
  panelState: WorkspacePanelState;
}

const MOBILE_SYNC_DEBOUNCE_MS = 100;
const MOBILE_SYNC_MAX_WAIT_MS = 1000;
const MOBILE_SUBSCRIBER_POLL_MS = 1000;
const TERMINAL_CONTENT_TAB_ID = 'terminal';
const DEFAULT_WORKSPACE_PANEL_STATE: WorkspacePanelState = {
  tab: 'explorer',
  selectedFilePath: null,
  selectedChangePath: null,
};
const EMPTY_WORKSPACE_CONTENT_STATE: WorkspaceContentState = {
  tabs: [],
  activeTabId: TERMINAL_CONTENT_TAB_ID,
  dirtyTabIds: {},
  panelState: DEFAULT_WORKSPACE_PANEL_STATE,
};

function workspaceContentStateWithDefaults(
  state: WorkspaceContentState | undefined,
): WorkspaceContentState {
  return state ?? EMPTY_WORKSPACE_CONTENT_STATE;
}

function workspaceContentStateWithPanelDefaults(
  state: WorkspaceContentState,
): WorkspaceContentState {
  return {
    ...state,
    panelState: state.panelState ?? DEFAULT_WORKSPACE_PANEL_STATE,
  };
}
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

declare global {
  interface Window {
    __terminalManager?: {
      openCreate: () => void;
      closeCreate: () => void;
      setViewMode: (mode: ViewMode) => void;
      openSettings: (tab?: SettingsTab) => void;
      openPalette: () => void;
      closePalette: () => void;
      requestRemoveCard: (cardId: string) => Promise<boolean>;
      requestArchiveCard: (cardId: string) => Promise<boolean>;
    };
  }
}

export function TerminalManager() {
  const { t } = useTranslation('terminal');
  const cards = useTerminalStore((s) => s.cards);
  const archivedCards = useTerminalStore((s) => s.archivedCards);
  const focusedCardId = useTerminalStore((s) => s.focusedCardId);
  const focusCard = useTerminalStore((s) => s.focusCard);
  const createCard = useTerminalStore((s) => s.createCard);
  const restoreArchivedCard = useTerminalStore((s) => s.restoreArchivedCard);
  const selectProject = useTerminalStore((s) => s.selectProject);
  const selectWorktree = useTerminalStore((s) => s.selectWorktree);
  const toggleNotificationCentre = useTerminalStore((s) => s.toggleNotificationCentre);
  const unreadCount = useTerminalStore((s) => s.notifications.filter((n) => !n.read).length);
  const selectedProjectPath = useTerminalStore((s) => s.selectedProjectPath);
  const selectedWorktreePath = useTerminalStore((s) => s.selectedWorktreePath);
  const selectedWorktreeLabel = useTerminalStore((s) => s.selectedWorktreeLabel);
  const pendingFocusCardId = useTerminalStore((s) => s.pendingFocusCardId);
  const setPendingFocusCardId = useTerminalStore((s) => s.setPendingFocusCardId);
  const pendingLocateCardId = useTerminalStore((s) => s.pendingLocateCardId);
  const setPendingLocateCardId = useTerminalStore((s) => s.setPendingLocateCardId);
  const highlightCard = useTerminalStore((s) => s.highlightCard);
  const updateCardAiIntent = useTerminalStore((s) => s.updateCardAiIntent);
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

  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [primaryView, setPrimaryView] = useState<PrimaryView>('workbench');
  const returnPrimaryViewRef = useRef<PrimaryView>('workbench');
  const previousFocusedCardIdRef = useRef<string | null>(null);
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
  const { mobileWorkbenchModel, workbenchModel } = useWorkbenchModel({
    cards,
    selectedProjectPath,
    selectedWorktreePath,
  });
  const [workspaceContentByCardId, setWorkspaceContentByCardId] = useState<
    Record<string, WorkspaceContentState>
  >({});
  const workspaceContentByCardIdRef = useRef(workspaceContentByCardId);
  workspaceContentByCardIdRef.current = workspaceContentByCardId;
  useStatsSubscription();
  useStatsAutoRefresh();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialGroup, setPaletteInitialGroup] = useState<CommandGroup | null>(null);

  // Shortcut hint: dismissible, persisted across sessions. Once the user
  // closes it, never show again unless they wipe localStorage.
  const HINT_DISMISS_KEY = 'threadterm-shortcut-hint-dismissed';
  const [hintDismissed, setHintDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HINT_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const dismissHint = useCallback(() => {
    setHintDismissed(true);
    try {
      localStorage.setItem(HINT_DISMISS_KEY, '1');
    } catch {
      // localStorage unavailable — dismissal is session-only.
    }
  }, []);

  // Card ids whose TerminalView is kept mounted, in LRU order (oldest first).
  // Each mounted view holds a WebGL context, so the list is capped at
  // MAX_MOUNTED_TERMINAL_VIEWS (audit P1-1): evicted views unmount their
  // xterm while the PTY survives in Rust (`preservePtyOnUnmount`), and
  // re-focusing replays history via Shell's attachSnapshot path. Using an
  // array ref (plus forceRender counter) avoids re-mounting when cards array
  // refs change.
  const mountedIdsRef = useRef<string[]>([]);
  const [, bumpRender] = useState(0);
  const [mobileBridgeSyncEnabled, setMobileBridgeSyncEnabled] = useState(false);
  const [mobileBridgeSyncActive, setMobileBridgeSyncActive] = useState(false);
  const lastMobileSyncPayloadRef = useRef('');
  const pendingMobileSyncRef = useRef<{
    fingerprint: string;
    args: Parameters<typeof mobileBridge.syncState>;
  } | null>(null);
  const mobileSyncTrailingTimerRef = useRef<number | null>(null);
  const mobileSyncMaxWaitTimerRef = useRef<number | null>(null);

  const mountCardInBackground = useCallback((cardId: string) => {
    const current = mountedIdsRef.current;
    const wasMounted = current.includes(cardId);
    // Read the focused card from the store (not from render scope) so this
    // callback stays referentially stable — it is a dependency of the mobile
    // bridge subscription effect and must not resubscribe on focus changes.
    const { next, evicted } = touchMountedId(
      current,
      cardId,
      MAX_MOUNTED_TERMINAL_VIEWS,
      useTerminalStore.getState().focusedCardId,
    );
    mountedIdsRef.current = next;
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
  const currentWorkspaceContent = workspaceContentStateWithPanelDefaults(
    workspaceContentStateWithDefaults(
      focusedCardId ? workspaceContentByCardId[focusedCardId] : undefined,
    ),
  );
  const workspaceContentTabs = currentWorkspaceContent.tabs;
  const activeContentTabId = currentWorkspaceContent.activeTabId;
  const dirtyWorkspaceTabIds = currentWorkspaceContent.dirtyTabIds;
  const workspacePanelState = currentWorkspaceContent.panelState;

  const activeWorkspaceTab = workspaceContentTabs.find((tab) => tab.id === activeContentTabId) ?? null;
  const workspaceTabsVisible = viewMode === 'focus' && !!focusedCard && workspaceContentTabs.length > 0;
  const terminalContentActive = activeContentTabId === TERMINAL_CONTENT_TAB_ID;
  const activeWorkspaceFilePath = activeWorkspaceTab?.kind === 'file' ? activeWorkspaceTab.path : null;
  const activeWorkspaceDiffPath =
    activeWorkspaceTab?.kind === 'diff' ? activeWorkspaceTab.change.path : null;

  const mountedWorkspaceContentViews = useMemo(() => {
    const views: Array<{ cardId: string; tab: WorkspaceContentTab }> = [];
    for (const card of cards) {
      const state = workspaceContentStateWithPanelDefaults(
        workspaceContentStateWithDefaults(workspaceContentByCardId[card.id]),
      );
      for (const tab of state.tabs) {
        if (card.id === focusedCardId || state.dirtyTabIds[tab.id]) {
          views.push({ cardId: card.id, tab });
        }
      }
    }
    return views;
  }, [cards, focusedCardId, workspaceContentByCardId]);

  const updateWorkspaceContentForCard = useCallback(
    (cardId: string, updater: (state: WorkspaceContentState) => WorkspaceContentState) => {
      setWorkspaceContentByCardId((current) => {
        const previous = workspaceContentStateWithPanelDefaults(
          workspaceContentStateWithDefaults(current[cardId]),
        );
        const next = updater(previous);
        if (next === previous) return current;
        return { ...current, [cardId]: next };
      });
    },
    [],
  );

  const updateFocusedWorkspaceContent = useCallback(
    (updater: (state: WorkspaceContentState) => WorkspaceContentState) => {
      if (!focusedCardId) return;
      updateWorkspaceContentForCard(focusedCardId, updater);
    },
    [focusedCardId, updateWorkspaceContentForCard],
  );

  const setActiveContentTabId = useCallback(
    (tabId: string) => {
      updateFocusedWorkspaceContent((state) =>
        state.activeTabId === tabId ? state : { ...state, activeTabId: tabId },
      );
    },
    [updateFocusedWorkspaceContent],
  );

  useEffect(() => {
    if (
      activeContentTabId !== TERMINAL_CONTENT_TAB_ID &&
      !workspaceContentTabs.some((tab) => tab.id === activeContentTabId)
    ) {
      setActiveContentTabId(TERMINAL_CONTENT_TAB_ID);
    }
  }, [activeContentTabId, setActiveContentTabId, workspaceContentTabs]);

  const openWorkspaceFileForCard = useCallback(
    (cardId: string, rootPath: string, entry: DirEntry) => {
      const id = workspaceFileTabId(rootPath, entry.path);
      updateWorkspaceContentForCard(cardId, (state) => {
        const tabs = state.tabs.some((tab) => tab.id === id)
          ? state.tabs
          : [
              ...state.tabs,
              {
                id,
                kind: 'file' as const,
                rootPath,
                path: entry.path,
                title: pathBasename(entry.path),
              },
            ];
        return { ...state, tabs, activeTabId: id };
      });
    },
    [updateWorkspaceContentForCard],
  );

  const openWorkspaceFile = useCallback(
    (rootPath: string, entry: DirEntry) => {
      if (!focusedCardId) return;
      openWorkspaceFileForCard(focusedCardId, rootPath, entry);
    },
    [focusedCardId, openWorkspaceFileForCard],
  );

  const openWorkspaceDiff = useCallback(
    (entry: GitStatusEntry) => {
      const id = workspaceDiffTabId(entry.repositoryRoot, entry.path);
      updateFocusedWorkspaceContent((state) => {
        const existing = state.tabs.find((tab) => tab.id === id);
        const nextTab: WorkspaceContentTab = {
          id,
          kind: 'diff',
          change: entry,
          title: pathBasename(entry.path),
        };
        const tabs = existing
          ? state.tabs.map((tab) => (tab.id === id ? nextTab : tab))
          : [...state.tabs, nextTab];
        return { ...state, tabs, activeTabId: id };
      });
    },
    [updateFocusedWorkspaceContent],
  );

  const markWorkspaceTabDirty = useCallback(
    (cardId: string, tabId: string, dirty: boolean) => {
      updateWorkspaceContentForCard(cardId, (state) => {
        if (dirty) {
          if (state.dirtyTabIds[tabId]) return state;
          return { ...state, dirtyTabIds: { ...state.dirtyTabIds, [tabId]: true } };
        }
        if (!state.dirtyTabIds[tabId]) return state;
        const { [tabId]: _removed, ...rest } = state.dirtyTabIds;
        return { ...state, dirtyTabIds: rest };
      });
    },
    [updateWorkspaceContentForCard],
  );

  const closeWorkspaceTabs = useCallback(
    async (tabIds: string[], nextActiveTabId?: string) => {
      if (!focusedCardId || tabIds.length === 0) return;
      const targetIds = new Set(tabIds);
      const hasDirtyTarget = tabIds.some((tabId) => dirtyWorkspaceTabIds[tabId]);
      if (hasDirtyTarget) {
        const shouldClose = await confirmDialog(
          t('workspace.discardChangesConfirm', {
            defaultValue: 'Discard unsaved file changes?',
          }),
          t('workspace.unsavedTitle', { defaultValue: 'Unsaved changes' }),
        );
        if (!shouldClose) return;
      }

      setWorkspaceContentByCardId((current) => {
        const state = workspaceContentStateWithPanelDefaults(
          workspaceContentStateWithDefaults(current[focusedCardId]),
        );
        const tabs = state.tabs.filter((tab) => !targetIds.has(tab.id));
        const dirtyTabIds = Object.fromEntries(
          Object.entries(state.dirtyTabIds).filter(([tabId]) => !targetIds.has(tabId)),
        );
        const activeTabId =
          nextActiveTabId ??
          (targetIds.has(state.activeTabId) ? TERMINAL_CONTENT_TAB_ID : state.activeTabId);
        return {
          ...current,
          [focusedCardId]: {
            ...state,
            tabs,
            dirtyTabIds,
            activeTabId,
          },
        };
      });
    },
    [dirtyWorkspaceTabIds, focusedCardId, t],
  );

  const closeWorkspaceTab = useCallback(
    (tabId: string) => closeWorkspaceTabs([tabId]),
    [closeWorkspaceTabs],
  );

  const closeAllWorkspaceTabs = useCallback(
    () => closeWorkspaceTabs(workspaceContentTabs.map((tab) => tab.id)),
    [closeWorkspaceTabs, workspaceContentTabs],
  );

  const closeOtherWorkspaceTabs = useCallback(
    (tabId: string) =>
      closeWorkspaceTabs(
        workspaceContentTabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id),
        tabId,
      ),
    [closeWorkspaceTabs, workspaceContentTabs],
  );

  const requestCardExit = useCallback(
    async (cardId: string, action: 'remove' | 'archive'): Promise<boolean> => {
      const cardExists = useTerminalStore
        .getState()
        .cards
        .some((card) => card.id === cardId);
      if (!cardExists) return false;

      const workspaceState = workspaceContentByCardIdRef.current[cardId];
      const hasDirtyDraft = Object.values(workspaceState?.dirtyTabIds ?? {}).some(Boolean);
      if (hasDirtyDraft) {
        const shouldDiscard = await confirmDialog(
          t('workspace.discardChangesConfirm', {
            defaultValue: 'Discard unsaved file changes?',
          }),
          t('workspace.unsavedTitle', { defaultValue: 'Unsaved changes' }),
        );
        if (!shouldDiscard) return false;
      }

      const store = useTerminalStore.getState();
      if (!store.cards.some((card) => card.id === cardId)) return false;

      setWorkspaceContentByCardId((current) => {
        if (!(cardId in current)) return current;
        const { [cardId]: _discarded, ...next } = current;
        workspaceContentByCardIdRef.current = next;
        return next;
      });

      if (action === 'archive') {
        store.archiveCard(cardId);
      } else {
        store.removeCard(cardId);
      }
      return true;
    },
    [t],
  );

  const requestRemoveCard = useCallback(
    (cardId: string) => requestCardExit(cardId, 'remove'),
    [requestCardExit],
  );
  const requestArchiveCard = useCallback(
    (cardId: string) => requestCardExit(cardId, 'archive'),
    [requestCardExit],
  );

  const handleWorkspacePanelStateChange = useCallback(
    (panelState: WorkspacePanelState) => {
      updateFocusedWorkspaceContent((state) => ({ ...state, panelState }));
    },
    [updateFocusedWorkspaceContent],
  );

  // Mark the focused card as most-recently-used (mounting it if needed and
  // evicting the LRU view when over cap). The focused card itself is the
  // protected id inside touchMountedId, so it can never be evicted.
  useEffect(() => {
    if (!focusedCardId) return;
    mountCardInBackground(focusedCardId);
  }, [focusedCardId, mountCardInBackground]);

  useEffect(() => {
    if (!isTauriEnv()) return;
    let cancelled = false;

    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => {
        if (cancelled) return;
        setMobileBridgeSyncEnabled(getCurrentWindow().label === 'main');
      })
      .catch(() => {
        if (!cancelled) setMobileBridgeSyncEnabled(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const mobileBridgeCards = useMemo(() => cards.map(cardToMobileMeta), [cards]);
  const mobileBridgeNotifications = useMemo(
    () => notificationsToMobile(mobileWorkbenchModel.notifications),
    [mobileWorkbenchModel.notifications],
  );
  const mobileWorkbenchProjection = useMemo(
    () =>
      buildMobileWorkbenchProjection({
        generatedAt: mobileWorkbenchModel.now,
        summary: mobileWorkbenchModel.summary,
        attentionItems: mobileWorkbenchModel.attentionItems,
        groups: mobileWorkbenchModel.groups,
        rules: mobileWorkbenchModel.rules,
      }),
    [
      mobileWorkbenchModel.attentionItems,
      mobileWorkbenchModel.groups,
      mobileWorkbenchModel.now,
      mobileWorkbenchModel.rules,
      mobileWorkbenchModel.summary,
    ],
  );

  const clearMobileSyncTimers = useCallback(() => {
    if (mobileSyncTrailingTimerRef.current !== null) {
      window.clearTimeout(mobileSyncTrailingTimerRef.current);
      mobileSyncTrailingTimerRef.current = null;
    }
    if (mobileSyncMaxWaitTimerRef.current !== null) {
      window.clearTimeout(mobileSyncMaxWaitTimerRef.current);
      mobileSyncMaxWaitTimerRef.current = null;
    }
  }, []);

  const flushMobileSync = useCallback(() => {
    clearMobileSyncTimers();
    const pending = pendingMobileSyncRef.current;
    pendingMobileSyncRef.current = null;
    if (!pending || pending.fingerprint === lastMobileSyncPayloadRef.current) return;

    lastMobileSyncPayloadRef.current = pending.fingerprint;
    void mobileBridge.syncState(...pending.args).catch((error) => {
      console.warn('[MobileBridge] failed to sync state', error);
    });
  }, [clearMobileSyncTimers]);

  useEffect(() => {
    if (!mobileBridgeSyncEnabled) {
      setMobileBridgeSyncActive(false);
      return;
    }
    let cancelled = false;

    const refreshSubscriberState = async () => {
      try {
        const active = await mobileBridgeHasSubscribers();
        if (!cancelled) setMobileBridgeSyncActive(active);
      } catch {
        if (!cancelled) setMobileBridgeSyncActive(false);
      }
    };

    void refreshSubscriberState();
    const interval = window.setInterval(
      () => void refreshSubscriberState(),
      MOBILE_SUBSCRIBER_POLL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [mobileBridgeSyncEnabled]);

  useEffect(() => {
    if (!mobileBridgeSyncActive) {
      pendingMobileSyncRef.current = null;
      clearMobileSyncTimers();
      lastMobileSyncPayloadRef.current = '';
      return;
    }
    const fingerprint = JSON.stringify({
      cards: mobileBridgeCards,
      notifications: mobileBridgeNotifications,
      workbench: mobileWorkbenchProjection,
    });
    if (fingerprint === lastMobileSyncPayloadRef.current) return;

    pendingMobileSyncRef.current = {
      fingerprint,
      args: [
        mobileBridgeCards,
        mobileBridgeNotifications,
        mobileWorkbenchProjection,
      ],
    };
    if (mobileSyncTrailingTimerRef.current !== null) {
      window.clearTimeout(mobileSyncTrailingTimerRef.current);
    }
    mobileSyncTrailingTimerRef.current = window.setTimeout(
      flushMobileSync,
      MOBILE_SYNC_DEBOUNCE_MS,
    );
    if (mobileSyncMaxWaitTimerRef.current === null) {
      mobileSyncMaxWaitTimerRef.current = window.setTimeout(
        flushMobileSync,
        MOBILE_SYNC_MAX_WAIT_MS,
      );
    }
  }, [
    clearMobileSyncTimers,
    flushMobileSync,
    mobileBridgeCards,
    mobileBridgeNotifications,
    mobileBridgeSyncActive,
    mobileWorkbenchProjection,
  ]);

  useEffect(
    () => () => {
      pendingMobileSyncRef.current = null;
      clearMobileSyncTimers();
    },
    [clearMobileSyncTimers],
  );

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
      bumpRender((n) => n + 1);
    }
  }, [cards]);

  // Automatically enter focus mode when a card is focused, back to grid when cleared.
  useEffect(() => {
    if (focusedCardId && focusedCard) {
      if (!previousFocusedCardIdRef.current) {
        returnPrimaryViewRef.current = primaryView;
      }
      setViewMode('focus');
    } else {
      setViewMode('grid');
    }
    previousFocusedCardIdRef.current = focusedCardId;
  }, [focusedCardId, focusedCard, primaryView]);

  const focusMountedCard = useCallback(
    (cardId: string) => {
      mountCardInBackground(cardId);
      focusCard(cardId);
      setViewMode('focus');
    },
    [focusCard, mountCardInBackground],
  );

  useEffect(() => {
    if (!pendingFocusCardId) return;
    if (!cards.some((card) => card.id === pendingFocusCardId)) {
      setPendingFocusCardId(null);
      return;
    }
    returnPrimaryViewRef.current = primaryView;
    setWorkbenchPanel(null);
    closeRightSurface('workbench');
    setMobileViewActive(false);
    focusMountedCard(pendingFocusCardId);
    setPendingFocusCardId(null);
  }, [
    cards,
    closeRightSurface,
    focusMountedCard,
    pendingFocusCardId,
    primaryView,
    setPendingFocusCardId,
  ]);

  // Notification locate channel — the smart-hybrid grid path. The card is
  // already visible at store level (openNotificationTarget fixed filters),
  // so a pulse is enough: the highlighted card scrolls itself into view.
  useEffect(() => {
    if (!pendingLocateCardId) return;
    if (cards.some((card) => card.id === pendingLocateCardId)) {
      if (terminalsVisible) {
        highlightCard(pendingLocateCardId);
      } else {
        returnPrimaryViewRef.current = primaryView;
        setWorkbenchPanel(null);
        closeRightSurface('workbench');
        setMobileViewActive(false);
        focusMountedCard(pendingLocateCardId);
      }
    }
    setPendingLocateCardId(null);
  }, [
    cards,
    closeRightSurface,
    focusMountedCard,
    highlightCard,
    pendingLocateCardId,
    primaryView,
    setPendingLocateCardId,
    terminalsVisible,
  ]);

  const handleOpenTerminal = useCallback(
    (cardId: string) => {
      returnPrimaryViewRef.current = primaryView;
      setWorkbenchPanel(null);
      closeRightSurface('workbench');
      setMobileViewActive(false);
      focusMountedCard(cardId);
    },
    [closeRightSurface, focusMountedCard, primaryView],
  );

  const handleBackToGrid = useCallback(() => {
    focusCard(null);
    setPrimaryView(returnPrimaryViewRef.current);
    setMobileViewActive(false);
    setViewMode('grid');
  }, [focusCard]);

  const handleSelectPrimaryView = useCallback(
    (view: PrimaryView) => {
      returnPrimaryViewRef.current = view;
      setPrimaryView(view);
      setMobileViewActive(false);
      setWorkbenchPanel(null);
      closeRightSurface('workbench');
      setSidebarOpen(false);
      if (focusedCardId) focusCard(null);
      setViewMode('grid');
    },
    [closeRightSurface, focusCard, focusedCardId],
  );

  const handleOpenMobileAccess = useCallback(() => {
    setMobileViewActive(true);
    setWorkbenchPanel(null);
    closeRightSurface('workbench');
    if (focusedCardId) focusCard(null);
    setViewMode('grid');
  }, [closeRightSurface, focusCard, focusedCardId]);

  const handleOpenWorkbenchPanel = useCallback(
    (panel: WorkbenchPanelState) => {
      setWorkbenchPanel(panel);
      openRightSurface('workbench');
    },
    [openRightSurface],
  );

  const handleCloseWorkbenchPanel = useCallback(() => {
    setWorkbenchPanel(null);
    closeRightSurface('workbench');
  }, [closeRightSurface]);

  const sessionDockVisible = sessionDockPanelVisible;

  const handleCloseSessionDock = useCallback(() => {
    if (dockPinned) toggleDockPin();
    closeRightSurface('sessionDock');
  }, [closeRightSurface, dockPinned, toggleDockPin]);

  const handleSelectSessionDockCard = useCallback(
    (cardId: string) => {
      focusMountedCard(cardId);
      setWorkspaceContentByCardId((current) => {
        const state = workspaceContentStateWithPanelDefaults(
          workspaceContentStateWithDefaults(current[cardId]),
        );
        if (state.activeTabId === TERMINAL_CONTENT_TAB_ID) return current;
        return {
          ...current,
          [cardId]: {
            ...state,
            activeTabId: TERMINAL_CONTENT_TAB_ID,
          },
        };
      });
    },
    [focusMountedCard],
  );

  const handleRestoreArchivedCard = useCallback(
    (cardId: string) => {
      restoreArchivedCard(cardId);
    },
    [restoreArchivedCard],
  );

  const handleOpenSettings = useCallback((tab: SettingsTab = 'shortcuts') => {
    void openSettingsWindow(tab).catch((error) => {
      console.warn('[settings] failed to open settings window', error);
    });
  }, []);

  // Stage 5.2 — palette entries derived from current store snapshot.
  const paletteProjects = useMemo(
    () => Array.from(new Set(cards.map((c) => c.projectPath))),
    [cards],
  );
  const paletteEntries = useMemo(
    () => {
      if (!paletteOpen) return [];
      return buildCommandRegistry({
        cards,
        projects: paletteProjects,
        focusedCardId,
        actions: {
          focusCard,
          selectProject,
          toggleNotificationCentre,
          updateCardAiIntent,
          openSettings: handleOpenSettings,
        },
      });
    },
    [
      paletteOpen,
      cards,
      paletteProjects,
      focusedCardId,
      focusCard,
      handleOpenSettings,
      selectProject,
      updateCardAiIntent,
      toggleNotificationCentre,
    ],
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

  // Expose imperative API.
  useEffect(() => {
    window.__terminalManager = {
      openCreate: () => setCreateOpen(true),
      closeCreate: () => setCreateOpen(false),
      setViewMode: (mode) => setViewMode(mode),
      openSettings: handleOpenSettings,
      openPalette: () => {
        setPaletteInitialGroup(null);
        setPaletteOpen(true);
      },
      closePalette: () => {
        setPaletteInitialGroup(null);
        setPaletteOpen(false);
      },
      requestRemoveCard,
      requestArchiveCard,
    };
    return () => {
      delete window.__terminalManager;
    };
  }, [handleOpenSettings, requestArchiveCard, requestRemoveCard]);

  const recentProjects = useMemo(
    () => cards.map((c) => ({ path: c.projectPath, name: c.projectName })),
    [cards],
  );
  const workbenchScopeLabel = selectedProjectName
    ? [selectedProjectName, selectedWorktreeLabel].filter(Boolean).join(' · ')
    : null;

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
          attentionCount={workbenchModel.summary.attention}
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
            attentionItems={workbenchModel.attentionItems}
            groups={workbenchModel.groups}
            summary={workbenchModel.summary}
            now={workbenchModel.now}
            scopeLabel={workbenchScopeLabel}
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
        onClose={() => {
          setPaletteInitialGroup(null);
          setPaletteOpen(false);
        }}
      />

      {/* Create dialog */}
      <CreateTerminalDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
        recentProjects={recentProjects}
      />

      </div>
    </div>
  );
}

function WorkspaceContentTabStrip({
  tabs,
  activeTabId,
  dirtyTabIds,
  terminalLabel,
  closeLabel,
  closeCurrentLabel,
  closeAllLabel,
  closeOthersLabel,
  onActivate,
  onClose,
  onCloseAll,
  onCloseOthers,
}: {
  tabs: WorkspaceContentTab[];
  activeTabId: string;
  dirtyTabIds: Record<string, boolean>;
  terminalLabel: string;
  closeLabel: string;
  closeCurrentLabel: string;
  closeAllLabel: string;
  closeOthersLabel: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseAll: () => void;
  onCloseOthers: (tabId: string) => void;
}) {
  const [menu, setMenu] = useState<{ tabId: string; left: number; top: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menu]);

  const openMenu = (event: ReactMouseEvent, tabId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 160;
    const height = 112;
    const padding = 8;
    setMenu({
      tabId,
      left: Math.min(event.clientX, window.innerWidth - width - padding),
      top: Math.min(event.clientY, window.innerHeight - height - padding),
    });
  };

  const runMenuAction = (action: () => void) => {
    setMenu(null);
    action();
  };

  return (
    <div
      className="flex min-h-[34px] items-center gap-1 overflow-x-auto border-b border-border bg-background/95 px-2 py-1"
      data-terminal-context-menu
    >
      <button
        type="button"
        onClick={() => onActivate(TERMINAL_CONTENT_TAB_ID)}
        className={[
          'inline-flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors',
          activeTabId === TERMINAL_CONTENT_TAB_ID
            ? 'bg-primary/15 text-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        ].join(' ')}
      >
        <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{terminalLabel}</span>
      </button>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          title={tab.kind === 'file' ? tab.path : tab.change.path}
          onContextMenu={(event) => openMenu(event, tab.id)}
          data-terminal-context-menu
          className={[
            'inline-flex h-7 max-w-[240px] shrink-0 items-center overflow-hidden rounded-md text-[11px] transition-colors',
            activeTabId === tab.id
              ? 'bg-primary/15 text-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
          ].join(' ')}
        >
          <button
            type="button"
            onClick={() => onActivate(tab.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1"
          >
            {tab.kind === 'file' ? (
              <FileText className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <GitCompare className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{tab.title}</span>
            {dirtyTabIds[tab.id] && (
              <AttentionDot size="sm" />
            )}
          </button>
          <button
            type="button"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={() => onClose(tab.id)}
            className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      {menu &&
        createPortal(
          <div
            role="menu"
            data-testid="workspace-tab-context-menu"
            data-terminal-context-menu
            className="fixed z-50 w-40 overflow-hidden rounded-md border border-border bg-popover py-1 text-[11px] text-popover-foreground shadow-xl shadow-black/30"
            style={{ left: menu.left, top: menu.top }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <WorkspaceTabMenuItem
              label={closeCurrentLabel}
              onClick={() => runMenuAction(() => onClose(menu.tabId))}
            />
            <WorkspaceTabMenuItem
              label={closeAllLabel}
              onClick={() => runMenuAction(onCloseAll)}
            />
            <WorkspaceTabMenuItem
              label={closeOthersLabel}
              onClick={() => runMenuAction(() => onCloseOthers(menu.tabId))}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

function WorkspaceTabMenuItem({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
    >
      {label}
    </button>
  );
}
