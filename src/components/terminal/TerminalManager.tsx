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
  Layers,
  Plus,
  Settings as SettingsIcon,
  Star,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import { BOOKMARKS_VISIBLE } from '../../lib/featureFlags';
import { CardGrid } from './CardGrid';
import { MAX_MOUNTED_TERMINAL_VIEWS, touchMountedId } from './mountedViewsLru';
import { TerminalView } from './TerminalView';
import { CreateTerminalDialog } from './CreateTerminalDialog';
import { ProjectSidebar } from './ProjectSidebar';
import { BookmarksSidebar } from './BookmarksSidebar';
import { ArchivedCardsPanel } from './ArchivedCardsPanel';
import { SessionDock } from './SessionDock';
import { StatsPanel } from '../stats/StatsPanel';
import { useStatsAutoRefresh, useStatsSubscription } from '../../stores/statsStore';
import { CommandPalette } from '../palette/CommandPalette';
import { buildCommandRegistry, type CommandGroup } from '../palette/commandRegistry';
import { BlockSearchPanel } from '../search/BlockSearchPanel';
import { WorkflowArgsDialog } from '../workflows/WorkflowArgsDialog';
import { ImportWorkflowDialog } from '../workflows/ImportWorkflowDialog';
import { interpolateWorkflow, type InterpolationValues } from '../../lib/workflows/interpolateWorkflow';
import { resolveWorkflowCwd } from '../../lib/workflows/dedupWorkflows';
import { useWorkflows } from '../../lib/workflows/useWorkflows';
import {
  missingDefaultArgs,
  workflowAiIntent,
  workflowTerminalType,
} from '../../lib/workflows/workflowRun';
import type { DiscoveredWorkflow } from '../../lib/workflows/discoverWorkflows';
import type { WorkflowImportPlan } from '../../lib/workflows/importWorkflow';
import type { TerminalCard, TerminalCreateOptions, TerminalStatus, TerminalType } from '../../types/terminal';
import { useSupervisor } from '../../lib/supervisor/useSupervisor';
import { git, isTauriEnv, mobileBridge, providerSessions, type GitStatusEntry } from '../../lib/tauri-bridge';
import { openSettingsWindow, type SettingsTab } from '../../lib/settingsWindow';
import { confirmDialog } from '../../lib/nativeDialog';
import type { CardMeta, TerminalStatus as MobileTerminalStatus } from '../../mobile/bridge/protocol';
import { cardMatchesWorktree } from '../../lib/worktreePaths';
import { clearProjectBranchCache } from './useProjectBranches';
import { clearProjectWorktreeCache } from './useProjectWorktrees';
import { WorkspacePanel, type WorkspacePanelState } from '../files/WorkspacePanel';
import {
  WorkspaceDiffView,
  WorkspaceFileEditorView,
} from '../files/WorkspaceContentViews';
import type { DirEntry } from '../files/fileMeta';

type ViewMode = 'grid' | 'focus';
type RightSurface = 'stats' | 'archive' | 'bookmarks' | 'sessionDock';
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

function pushRightSurface(stack: RightSurface[], surface: RightSurface): RightSurface[] {
  return [...stack.filter((item) => item !== surface), surface];
}

function removeRightSurface(stack: RightSurface[], surface: RightSurface): RightSurface[] {
  return stack.filter((item) => item !== surface);
}

function resolveActiveRightSurface(
  stack: RightSurface[],
  isAvailable: (surface: RightSurface) => boolean,
): RightSurface | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const surface = stack[i];
    if (isAvailable(surface)) return surface;
  }
  return null;
}

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

function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function workspaceFileTabId(rootPath: string, path: string): string {
  return `file:${encodeURIComponent(rootPath)}:${encodeURIComponent(path)}`;
}

function workspaceDiffTabId(repositoryRoot: string, path: string): string {
  return `diff:${encodeURIComponent(repositoryRoot)}:${encodeURIComponent(path)}`;
}

function toMobileStatus(status: TerminalStatus): MobileTerminalStatus {
  return status === 'waiting' ? 'waiting_for_input' : status;
}

function summaryLineFromCard(card: TerminalCard): string | null {
  const source = card.lastReplyPreview || card.lastOutput;
  const line = source
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(-1)[0];
  return line || null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function cardToMobileMeta(card: TerminalCard): CardMeta {
  return {
    id: card.id,
    ptyId: card.ptyId || card.id,
    status: toMobileStatus(card.status),
    projectPath: card.projectPath,
    projectName: card.projectName,
    worktreePath: card.worktreePath ?? null,
    terminalType: card.terminalType,
    command: card.command ?? null,
    createdAt: card.createdAt,
    lastActivity: card.lastActivity,
    lastReplyPreview: card.lastReplyPreview || card.lastOutput,
    summaryLine: summaryLineFromCard(card),
    hiddenLineCount: 0,
    recentOutputBytes: byteLength(card.lastOutput || card.lastReplyPreview || ''),
    messageCount: card.messageCount,
    unread: card.unread,
    providerSessionState: card.providerSessionState ?? null,
    ptyLive: false,
    ptyState: null,
    attachable: true,
  };
}

function normalizeTerminalType(value: string): TerminalType {
  return TERMINAL_TYPES.includes(value as TerminalType) ? (value as TerminalType) : 'custom';
}

declare global {
  interface Window {
    __terminalManager?: {
      openCreate: () => void;
      closeCreate: () => void;
      focusMode: (mode: ViewMode) => void;
      openSettings: (tab?: SettingsTab) => void;
      openPalette: () => void;
      closePalette: () => void;
      openSearch: () => void;
      closeSearch: () => void;
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
  const importProviderSessionCards = useTerminalStore((s) => s.importProviderSessionCards);
  const selectProject = useTerminalStore((s) => s.selectProject);
  const selectWorktree = useTerminalStore((s) => s.selectWorktree);
  const toggleNotificationCentre = useTerminalStore((s) => s.toggleNotificationCentre);
  const unreadCount = useTerminalStore((s) => s.notifications.filter((n) => !n.read).length);
  const selectedProjectPath = useTerminalStore((s) => s.selectedProjectPath);
  const selectedWorktreePath = useTerminalStore((s) => s.selectedWorktreePath);
  const selectedWorktreeLabel = useTerminalStore((s) => s.selectedWorktreeLabel);
  const pendingFocusCardId = useTerminalStore((s) => s.pendingFocusCardId);
  const setPendingFocusCardId = useTerminalStore((s) => s.setPendingFocusCardId);
  const selectBlock = useTerminalStore((s) => s.selectBlock);
  const bookmarkCount = useTerminalStore((s) => s.bookmarks.length);
  const blocks = useTerminalStore((s) => s.blocks);
  const updateCardAiIntent = useTerminalStore((s) => s.updateCardAiIntent);
  const pushNotification = useTerminalStore((s) => s.pushNotification);
  const dockPinned = useTerminalStore((s) => s.dockPinned);
  const toggleDockPin = useTerminalStore((s) => s.toggleDockPin);
  const { workflows, reload: reloadWorkflows } = useWorkflows();

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const [createOpen, setCreateOpen] = useState(false);
  const [rightSurfaceStack, setRightSurfaceStack] = useState<RightSurface[]>([]);
  const [workspaceContentByCardId, setWorkspaceContentByCardId] = useState<
    Record<string, WorkspaceContentState>
  >({});
  const [dockHovered, setDockHovered] = useState(false);
  useStatsSubscription();
  useStatsAutoRefresh();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialGroup, setPaletteInitialGroup] = useState<CommandGroup | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [workflowArgs, setWorkflowArgs] = useState<{
    workflow: DiscoveredWorkflow;
    missingArgs: string[];
  } | null>(null);
  const [importWorkflow, setImportWorkflow] = useState<{
    projectPath: string;
    projectName: string;
  } | null>(null);

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
  const lastMobileSyncPayloadRef = useRef('');

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

  // Live working directory of the focused card: the latest block's cwd
  // (updated by shell-integration as the user `cd`s), falling back to the
  // card's worktree / project path before any command has produced a block.
  const focusedCwd = useMemo(() => {
    if (!focusedCardId) return null;
    const cardBlocks = blocks[focusedCardId];
    const latest =
      cardBlocks && cardBlocks.length > 0 ? cardBlocks[cardBlocks.length - 1].cwd : '';
    const cwd = (latest || focusedCard?.worktreePath || focusedCard?.projectPath || '').trim();
    return cwd || null;
  }, [focusedCardId, blocks, focusedCard]);

  const sessionDockAvailable = viewMode === 'focus' && Boolean(focusedCard);

  const isRightSurfaceAvailable = useCallback(
    (surface: RightSurface) => {
      switch (surface) {
        case 'stats':
          return true;
        case 'archive':
          return Boolean(selectedProjectPath && selectedProjectName);
        case 'bookmarks':
          return BOOKMARKS_VISIBLE;
        case 'sessionDock':
          return sessionDockAvailable;
      }
    },
    [selectedProjectName, selectedProjectPath, sessionDockAvailable],
  );

  const activeRightSurface = useMemo(
    () => resolveActiveRightSurface(rightSurfaceStack, isRightSurfaceAvailable),
    [isRightSurfaceAvailable, rightSurfaceStack],
  );

  const openRightSurface = useCallback((surface: RightSurface) => {
    setRightSurfaceStack((current) => pushRightSurface(current, surface));
  }, []);

  const closeRightSurface = useCallback((surface: RightSurface) => {
    setRightSurfaceStack((current) => removeRightSurface(current, surface));
  }, []);

  useEffect(() => {
    closeRightSurface('archive');
  }, [closeRightSurface, selectedProjectPath]);

  useEffect(() => {
    if (!sessionDockAvailable) {
      closeRightSurface('sessionDock');
      setDockHovered(false);
    }
  }, [closeRightSurface, sessionDockAvailable]);

  useEffect(() => {
    if (dockPinned && sessionDockAvailable) {
      openRightSurface('sessionDock');
    } else if (!dockPinned) {
      closeRightSurface('sessionDock');
    }
  }, [closeRightSurface, dockPinned, openRightSurface, sessionDockAvailable]);

  // Auxiliary right-side surfaces share the fixed workspace rail. The most
  // recently opened surface wins, and closing it restores the workspace rail.
  const toggleRightPanel = useCallback(
    (panel: 'stats' | 'archive' | 'bookmarks') => {
      setRightSurfaceStack((current) =>
        activeRightSurface === panel
          ? removeRightSurface(current, panel)
          : pushRightSurface(current, panel),
      );
    },
    [activeRightSurface],
  );

  const workspaceRailVisible = viewMode === 'focus' && !!focusedCwd;
  const workspacePanelVisible = workspaceRailVisible && !activeRightSurface;
  const statsPanelVisible = activeRightSurface === 'stats';
  const archivePanelVisible =
    activeRightSurface === 'archive' && !!selectedProjectPath && !!selectedProjectName;
  const bookmarksPanelVisible = activeRightSurface === 'bookmarks' && BOOKMARKS_VISIBLE;
  const sessionDockPanelVisible = activeRightSurface === 'sessionDock' && sessionDockAvailable;
  const auxiliaryRightPanelOpen =
    statsPanelVisible || archivePanelVisible || bookmarksPanelVisible || sessionDockPanelVisible;
  const rightPanelOpen =
    workspaceRailVisible ||
    auxiliaryRightPanelOpen;
  const statsOpen = activeRightSurface === 'stats';
  const archiveOpen = activeRightSurface === 'archive';
  const bookmarksOpen = activeRightSurface === 'bookmarks';
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

  const updateFocusedWorkspaceContent = useCallback(
    (updater: (state: WorkspaceContentState) => WorkspaceContentState) => {
      if (!focusedCardId) return;
      setWorkspaceContentByCardId((current) => {
        const previous = workspaceContentStateWithPanelDefaults(
          workspaceContentStateWithDefaults(current[focusedCardId]),
        );
        const next = updater(previous);
        if (next === previous) return current;
        return { ...current, [focusedCardId]: next };
      });
    },
    [focusedCardId],
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

  const openWorkspaceFile = useCallback(
    (rootPath: string, entry: DirEntry) => {
      const id = workspaceFileTabId(rootPath, entry.path);
      updateFocusedWorkspaceContent((state) => {
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
    [updateFocusedWorkspaceContent],
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
    (tabId: string, dirty: boolean) => {
      updateFocusedWorkspaceContent((state) => {
        if (dirty) {
          if (state.dirtyTabIds[tabId]) return state;
          return { ...state, dirtyTabIds: { ...state.dirtyTabIds, [tabId]: true } };
        }
        if (!state.dirtyTabIds[tabId]) return state;
        const { [tabId]: _removed, ...rest } = state.dirtyTabIds;
        return { ...state, dirtyTabIds: rest };
      });
    },
    [updateFocusedWorkspaceContent],
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

    void providerSessions
      .listRecent()
      .then((sessions) => {
        if (!cancelled) importProviderSessionCards(sessions);
      })
      .catch((error) => {
        console.warn('[ProviderSessions] failed to import existing sessions', error);
      });

    return () => {
      cancelled = true;
    };
  }, [importProviderSessionCards]);

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

  useEffect(() => {
    if (!mobileBridgeSyncEnabled) return;
    const payload = JSON.stringify(mobileBridgeCards);
    if (payload === lastMobileSyncPayloadRef.current) return;

    const timer = window.setTimeout(() => {
      lastMobileSyncPayloadRef.current = payload;
      void mobileBridge.syncCards(mobileBridgeCards).catch((error) => {
        console.warn('[MobileBridge] failed to sync cards', error);
      });
    }, MOBILE_SYNC_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [mobileBridgeCards, mobileBridgeSyncEnabled]);

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
      mobileBridge.onRemoveCard((payload) => {
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

        useTerminalStore.getState().removeCard(payload.cardId);
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
  }, [mobileBridgeSyncEnabled, mountCardInBackground]);

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
      setViewMode('focus');
    } else {
      setViewMode('grid');
    }
  }, [focusedCardId, focusedCard]);

  useEffect(() => {
    if (!pendingFocusCardId) return;
    if (!cards.some((card) => card.id === pendingFocusCardId)) {
      setPendingFocusCardId(null);
      return;
    }
    focusCard(pendingFocusCardId);
    setViewMode('focus');
    setPendingFocusCardId(null);
  }, [cards, focusCard, pendingFocusCardId, setPendingFocusCardId]);

  const handleOpenTerminal = useCallback(
    (cardId: string) => {
      focusCard(cardId);
      setViewMode('focus');
    },
    [focusCard],
  );

  const handleBackToGrid = useCallback(() => {
    focusCard(null);
    setViewMode('grid');
  }, [focusCard]);

  const sessionDockVisible = sessionDockPanelVisible;

  useEffect(() => {
    if (!sessionDockAvailable && dockHovered) {
      setDockHovered(false);
    }
  }, [dockHovered, sessionDockAvailable]);

  const handleCloseSessionDock = useCallback(() => {
    if (dockPinned) toggleDockPin();
    setDockHovered(false);
    closeRightSurface('sessionDock');
  }, [closeRightSurface, dockPinned, toggleDockPin]);

  const handleSelectSessionDockCard = useCallback(
    (cardId: string) => {
      focusCard(cardId);
      setViewMode('focus');
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
    [focusCard],
  );

  const handleSessionDockHoverChange = useCallback(
    (hovered: boolean) => {
      setDockHovered(hovered);
      if (hovered) {
        openRightSurface('sessionDock');
      } else if (!dockPinned) {
        closeRightSurface('sessionDock');
      }
    },
    [closeRightSurface, dockPinned, openRightSurface],
  );

  const handleJumpToBlock = useCallback(
    ({ cardId, blockId }: { cardId: string; blockId: string }) => {
      focusCard(cardId);
      setViewMode('focus');
      selectBlock(cardId, blockId);
      closeRightSurface('bookmarks');
    },
    [closeRightSurface, focusCard, selectBlock],
  );

  const handleRestoreArchivedCard = useCallback(
    (cardId: string) => {
      restoreArchivedCard(cardId);
    },
    [restoreArchivedCard],
  );

  const getWorkflowProjectContext = useCallback(
    (workflow: DiscoveredWorkflow) => {
      const selectedCard = selectedProjectPath
        ? cards.find((card) => card.projectPath === selectedProjectPath)
        : undefined;
      const sourceCard = focusedCard ?? selectedCard ?? visibleCards[0] ?? cards[0];
      const fallbackPath = selectedProjectPath ?? sourceCard?.projectPath ?? null;
      if (!fallbackPath) {
        return null;
      }
      return {
        projectPath: fallbackPath,
        projectName:
          sourceCard?.projectPath === fallbackPath
            ? sourceCard.projectName
            : pathBasename(fallbackPath),
        cwd: resolveWorkflowCwd(workflow.cwd, fallbackPath),
      };
    },
    [cards, focusedCard, selectedProjectPath, visibleCards],
  );

  const createWorkflowCard = useCallback(
    (workflow: DiscoveredWorkflow, command: string) => {
      const context = getWorkflowProjectContext(workflow);
      if (!context) {
        pushNotification({
          cardId: 'system:workflows',
          kind: 'failed',
          title: t('workflow.runWorkflow', { defaultValue: 'Run workflow' }),
          body: t('workflow.noProject', {
            defaultValue: 'Select a project before running a workflow.',
          }),
        });
        return;
      }

      const id = createCard({
        projectName: context.projectName,
        projectPath: context.projectPath,
        worktreePath: context.cwd !== context.projectPath ? context.cwd : undefined,
        terminalType: workflowTerminalType(workflow),
        command,
      });
      const intent = workflowAiIntent(workflow);
      if (intent) updateCardAiIntent(id, intent);
      selectProject(context.projectPath);
      focusCard(id);
      setViewMode('focus');
    },
    [
      createCard,
      focusCard,
      getWorkflowProjectContext,
      pushNotification,
      selectProject,
      t,
      updateCardAiIntent,
    ],
  );

  const handleRunWorkflow = useCallback(
    (workflow: DiscoveredWorkflow, values?: InterpolationValues) => {
      if (!values) {
        const missingDefaults = missingDefaultArgs(workflow);
        if (missingDefaults.length > 0) {
          setWorkflowArgs({ workflow, missingArgs: missingDefaults });
          return;
        }
      }

      const result = interpolateWorkflow(workflow, values);
      if (result.kind === 'missing') {
        setWorkflowArgs({ workflow, missingArgs: result.missingArgs });
        return;
      }
      createWorkflowCard(workflow, result.command);
      setWorkflowArgs(null);
      setPaletteOpen(false);
    },
    [createWorkflowCard],
  );

  const handleOpenWorkflowPalette = useCallback(() => {
    setPaletteInitialGroup('run-workflow');
    setPaletteOpen(true);
  }, []);

  const handleOpenImportWorkflow = useCallback(
    (projectPath: string, projectName: string) => {
      setImportWorkflow({
        projectPath,
        projectName: projectName || pathBasename(projectPath),
      });
    },
    [],
  );

  const handleOpenSettings = useCallback((tab: SettingsTab = 'shortcuts') => {
    void openSettingsWindow(tab).catch((error) => {
      console.warn('[settings] failed to open settings window', error);
    });
  }, []);

  const handleWorkflowImported = useCallback(
    (plan: WorkflowImportPlan) => {
      pushNotification({
        cardId: 'system:workflows',
        kind: 'completed',
        title: t('workflow.importWorkflowTitle', {
          defaultValue: 'Import workflow from URL',
        }),
        body: t('workflow.importWorkflowSuccess', {
          count: plan.workflows.length,
          file: plan.targetFileName,
          defaultValue: 'Imported {{count}} workflow(s) to {{file}}.',
        }),
      });
      setImportWorkflow(null);
      reloadWorkflows();
    },
    [pushNotification, reloadWorkflows, t],
  );

  // Stage 5.2 — palette entries derived from current store snapshot.
  const paletteProjects = useMemo(
    () => Array.from(new Set(cards.map((c) => c.projectPath))),
    [cards],
  );
  const paletteEntries = useMemo(
    () =>
      buildCommandRegistry({
        cards,
        blocks,
        projects: paletteProjects,
        workflows,
        focusedCardId,
        actions: {
          focusCard,
          selectProject,
          selectBlock,
          toggleNotificationCentre,
          runWorkflow: handleRunWorkflow,
          updateCardAiIntent,
          openSettings: handleOpenSettings,
        },
      }),
    [
      cards,
      blocks,
      paletteProjects,
      workflows,
      focusedCardId,
      focusCard,
      handleOpenSettings,
      handleRunWorkflow,
      selectProject,
      selectBlock,
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
      focusCard(id);
      setViewMode('focus');
    },
    [createCard, focusCard, selectProject, selectWorktree],
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
        focusCard(id);
        setViewMode('focus');
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
    [cards, createCard, focusCard, pushNotification, selectWorktree, selectedProjectName, t],
  );

  // Stage 5 — let Esc close the bookmarks side panel. Modals (palette /
  // search) own their own Esc handlers; this listener is gated on those
  // being closed so it never steals an Esc keystroke from them.
  useEffect(() => {
    if (!bookmarksOpen || paletteOpen || searchOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRightSurface('bookmarks');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [bookmarksOpen, closeRightSurface, paletteOpen, searchOpen]);

  // Expose imperative API.
  useEffect(() => {
    window.__terminalManager = {
      openCreate: () => setCreateOpen(true),
      closeCreate: () => setCreateOpen(false),
      focusMode: (mode) => setViewMode(mode),
      openSettings: handleOpenSettings,
      openPalette: () => {
        setPaletteInitialGroup(null);
        setPaletteOpen(true);
      },
      closePalette: () => {
        setPaletteInitialGroup(null);
        setPaletteOpen(false);
      },
      openSearch: () => setSearchOpen(true),
      closeSearch: () => setSearchOpen(false),
    };
    return () => {
      delete window.__terminalManager;
    };
  }, [handleOpenSettings]);

  const recentProjects = useMemo(
    () => cards.map((c) => ({ path: c.projectPath, name: c.projectName })),
    [cards],
  );
  const gridVisible = viewMode === 'grid' || !focusedCard;

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
          onImportWorkflow={handleOpenImportWorkflow}
          onCloseMobile={() => setSidebarOpen(false)}
        />
      </div>

      {/* Mobile Sidebar Backdrop */}
      {isMobile && sidebarOpen && (
        <div
          className="absolute inset-0 z-30 bg-background/40 backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className="relative flex min-w-0 flex-1 flex-col glass-reflection">
      {/* Top bar */}
      <div className="flex items-center justify-between etched-border-b bg-background/60 px-4 py-3 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-2">
          {isMobile && (
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="mr-1 rounded-[var(--radius-md)] p-1.5 hover:bg-accent"
            >
              <Layers className="h-4 w-4" />
            </button>
          )}
          <div className="text-sm font-semibold shrink-0 md:block hidden">{t('app.title')}</div>
          {selectedProjectName && (
            <>
              <span className="text-muted-foreground md:inline hidden">/</span>
              <span
                className="truncate rounded-[var(--radius-md)] bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
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
                className="truncate rounded-[var(--radius-md)] bg-foreground/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-foreground/80"
                title={selectedWorktreePath ?? undefined}
              >
                {selectedWorktreeLabel}
              </span>
            </>
          )}
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground sm:inline hidden">
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
                'relative inline-flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-[11px] font-medium',
                archiveOpen
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-accent hover:text-accent-foreground',
              ].join(' ')}
            >
              <Archive className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('archive.open')}</span>
              <span className="flex min-h-[14px] min-w-[14px] items-center justify-center rounded-full bg-muted px-1 text-[9px] font-bold text-muted-foreground">
                {selectedProjectArchivedCards.length > 99
                  ? '99+'
                  : selectedProjectArchivedCards.length}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            title={t('app.newTerminalTitle')}
            className="inline-flex items-center gap-1 rounded-[var(--radius-md)] bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> {t('app.new')}
          </button>
          {BOOKMARKS_VISIBLE && (
            <button
              type="button"
              onClick={() => toggleRightPanel('bookmarks')}
              title={t('bookmarks.toggle', { defaultValue: 'Toggle bookmarks panel' })}
              className={[
                'relative rounded-[var(--radius-md)] p-1.5',
                bookmarksOpen
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-accent hover:text-accent-foreground',
              ].join(' ')}
            >
              <Star className="h-4 w-4" />
              {bookmarkCount > 0 && (
                <span className="absolute right-0.5 top-0.5 flex min-h-[14px] min-w-[14px] items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold text-white">
                  {bookmarkCount > 99 ? '99+' : bookmarkCount}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => toggleRightPanel('stats')}
            title={t('stats.toggle', { defaultValue: 'Token usage' })}
            className={[
              'rounded-[var(--radius-md)] p-1.5',
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
            className="rounded-[var(--radius-md)] p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => toggleNotificationCentre()}
            title={t('app.notificationsTitle')}
            className="relative rounded-[var(--radius-md)] p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            {unreadCount > 0 ? (
              <BellDot className="h-4 w-4 text-amber-500" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            {unreadCount > 0 && (
              <span className="absolute right-0.5 top-0.5 flex min-h-[14px] min-w-[14px] items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold text-white">
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
      <div className="flex min-h-0 flex-1 overflow-hidden">
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

      {/* Main body — grid + all ever-mounted terminal views share the same
          container; only the active focused view is visible. This is what keeps
          the PTY alive across navigation so CLIs don't re-initialise. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* Grid layer */}
        <motion.div
          animate={{ opacity: gridVisible ? 1 : 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          aria-hidden={!gridVisible}
          style={{ visibility: gridVisible ? 'visible' : 'hidden' }}
          className={[
            'absolute inset-0',
            gridVisible
              ? ''
              : 'pointer-events-none',
          ].join(' ')}
        >
          <CardGrid
            onCreateTerminal={handleGridCreateTerminal}
            onCreateWorktreeTerminal={handleCreateWorktreeTerminal}
            onOpenTerminal={handleOpenTerminal}
          />
        </motion.div>

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
                  onOpenBookmarks={
                    BOOKMARKS_VISIBLE ? () => toggleRightPanel('bookmarks') : undefined
                  }
                  onOpenWorkflows={handleOpenWorkflowPalette}
                  onOpenSettings={handleOpenSettings}
                />
              </div>
            );
          })}

        {workspaceContentTabs.map((tab) => {
          const isCurrent = viewMode === 'focus' && activeContentTabId === tab.id;
          return (
            <div
              key={tab.id}
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
                  onDirtyChange={(dirty) => markWorkspaceTabDirty(tab.id, dirty)}
                />
              ) : (
                <WorkspaceDiffView
                  change={tab.change}
                  active={isCurrent}
                  onOpenFile={openWorkspaceFile}
                  onDirtyChange={(dirty) => markWorkspaceTabDirty(tab.id, dirty)}
                />
              )}
            </div>
          );
        })}

        {sessionDockAvailable && (
          <button
            type="button"
            aria-label={t('dock.hoverHandle')}
            title={t('dock.hoverHandle')}
            onFocus={() => handleSessionDockHoverChange(true)}
            onMouseEnter={() => handleSessionDockHoverChange(true)}
            className={[
              // Narrow 6px hover strip to summon the dock. The previous 12px
              // `cursor-ew-resize` box sat over the terminal's right edge and
              // swallowed scrollbar + rightmost-column mouse input, and the
              // resize cursor wrongly implied the dock was width-draggable.
              'absolute bottom-0 right-0 top-0 z-[34] w-1.5 cursor-pointer transition-colors hover:bg-primary/20',
              // When the dock is showing it owns hover; don't keep blocking
              // the terminal edge underneath it.
              sessionDockVisible ? 'pointer-events-none' : '',
            ].join(' ')}
          />
        )}
      </div>
      </div>

      {/* Right-side panel column — mutually exclusive; lives inside the
          horizontal flex so it squeezes the terminal and stays within the
          terminal-area height, below the top bar (never covers the toolbar). */}
      {rightPanelOpen && (
        <aside className="flex w-80 shrink-0 flex-col border-l border-white/10 bg-background/90 backdrop-blur-2xl shadow-studio">
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
          {archivePanelVisible && selectedProjectName && (
            <ArchivedCardsPanel
              projectName={selectedProjectName}
              cards={selectedProjectArchivedCards}
              onRestore={handleRestoreArchivedCard}
              onClose={() => closeRightSurface('archive')}
            />
          )}
          {bookmarksPanelVisible && (
            <BookmarksSidebar onJump={handleJumpToBlock} onClose={() => closeRightSurface('bookmarks')} />
          )}
          {sessionDockVisible && (
            <SessionDock
              visible={sessionDockVisible}
              pinned={dockPinned}
              variant="panel"
              onClose={handleCloseSessionDock}
              onHoverChange={handleSessionDockHoverChange}
              onSelectCard={handleSelectSessionDockCard}
            />
          )}
        </aside>
      )}
      </div>

      {/* Shortcut hint — dismissible. Anchored to the LEFT so it can't
          overlap with the right-side BlockInspector / Bookmarks panel,
          and hidden whenever a modal/panel is open so it never sits on
          top of overlay UI. */}
      {cards.length > 0 &&
        terminalContentActive &&
        !hintDismissed &&
        !auxiliaryRightPanelOpen &&
        !sessionDockVisible &&
        !paletteOpen &&
        !searchOpen && (
        <div
          className={[
            'absolute left-3 z-10 flex select-none items-center gap-2 rounded-[var(--radius-md)] border border-white/10/60 bg-background/80 py-1 pl-2.5 pr-1 text-[10px] text-muted-foreground backdrop-blur',
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

      <WorkflowArgsDialog
        open={workflowArgs !== null}
        workflow={workflowArgs?.workflow ?? null}
        missingArgs={workflowArgs?.missingArgs ?? []}
        onCancel={() => setWorkflowArgs(null)}
        onSubmit={(values) => {
          if (!workflowArgs) return;
          handleRunWorkflow(workflowArgs.workflow, values);
        }}
      />

      <ImportWorkflowDialog
        open={importWorkflow !== null}
        projectName={importWorkflow?.projectName ?? ''}
        projectPath={importWorkflow?.projectPath ?? ''}
        onCancel={() => setImportWorkflow(null)}
        onImported={handleWorkflowImported}
      />

      {/* Cross-session block search (Cmd/Ctrl+F) */}
      <BlockSearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onJump={(target) => {
          handleJumpToBlock(target);
          setSearchOpen(false);
        }}
      />

      {/* Create dialog */}
      <CreateTerminalDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
        onImportWorkflow={handleOpenImportWorkflow}
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
      className="flex min-h-[34px] items-center gap-1 overflow-x-auto border-b border-white/10 bg-background/95 px-2 py-1"
      data-terminal-context-menu
    >
      <button
        type="button"
        onClick={() => onActivate(TERMINAL_CONTENT_TAB_ID)}
        className={[
          'inline-flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] px-2 text-[11px] transition-colors',
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
            'inline-flex h-7 max-w-[240px] shrink-0 items-center overflow-hidden rounded-[var(--radius-md)] text-[11px] transition-colors',
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
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden />
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
            className="fixed z-50 w-40 overflow-hidden rounded-[var(--radius-md)] border border-white/10 bg-popover py-1 text-[11px] text-popover-foreground shadow-xl shadow-black/30"
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
