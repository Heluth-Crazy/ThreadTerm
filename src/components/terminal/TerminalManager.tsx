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
import { Bell, BellDot, Layers, Plus, Settings as SettingsIcon, Star, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import { BOOKMARKS_VISIBLE } from '../../lib/featureFlags';
import { CardGrid } from './CardGrid';
import { TerminalView } from './TerminalView';
import { CreateTerminalDialog } from './CreateTerminalDialog';
import { ProjectSidebar } from './ProjectSidebar';
import { BookmarksSidebar } from './BookmarksSidebar';
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
import { isTauriEnv, mobileBridge, providerSessions } from '../../lib/tauri-bridge';
import { openSettingsWindow, type SettingsTab } from '../../lib/settingsWindow';
import type { CardMeta, TerminalStatus as MobileTerminalStatus } from '../../mobile/bridge/protocol';

type ViewMode = 'grid' | 'focus';

const MOBILE_SYNC_DEBOUNCE_MS = 100;
const TERMINAL_TYPES: TerminalType[] = [
  'shell',
  'claude',
  'codex',
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
  const focusedCardId = useTerminalStore((s) => s.focusedCardId);
  const focusCard = useTerminalStore((s) => s.focusCard);
  const createCard = useTerminalStore((s) => s.createCard);
  const importProviderSessionCards = useTerminalStore((s) => s.importProviderSessionCards);
  const selectProject = useTerminalStore((s) => s.selectProject);
  const toggleNotificationCentre = useTerminalStore((s) => s.toggleNotificationCentre);
  const unreadCount = useTerminalStore((s) => s.notifications.filter((n) => !n.read).length);
  const selectedProjectPath = useTerminalStore((s) => s.selectedProjectPath);
  const pendingFocusCardId = useTerminalStore((s) => s.pendingFocusCardId);
  const setPendingFocusCardId = useTerminalStore((s) => s.setPendingFocusCardId);
  const selectBlock = useTerminalStore((s) => s.selectBlock);
  const bookmarkCount = useTerminalStore((s) => s.bookmarks.length);
  const blocks = useTerminalStore((s) => s.blocks);
  const updateCardAiIntent = useTerminalStore((s) => s.updateCardAiIntent);
  const pushNotification = useTerminalStore((s) => s.pushNotification);
  const { workflows, reload: reloadWorkflows } = useWorkflows();

  // AI Supervisor v0.1 — single mount point in the React tree. Hook is a no-op
  // when `supervisorEnabled` is false, so this is safe to call unconditionally.
  useSupervisor();

  const selectedProjectName = useMemo(() => {
    if (!selectedProjectPath) return null;
    const card = cards.find((c) => c.projectPath === selectedProjectPath);
    return card?.projectName ?? selectedProjectPath;
  }, [cards, selectedProjectPath]);

  // Cards visible with the current project filter applied.
  const visibleCards = useMemo(
    () =>
      selectedProjectPath
        ? cards.filter((c) => c.projectPath === selectedProjectPath)
        : cards,
    [cards, selectedProjectPath],
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
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
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

  // Set of card ids whose TerminalView should be kept mounted. A view is
  // added the first time the user focuses the card and is only removed when
  // the card itself is deleted. Using a Set ref (plus forceRender counter)
  // avoids re-mounting when cards array refs change.
  const mountedIdsRef = useRef<Set<string>>(new Set());
  const [, bumpRender] = useState(0);
  const [mobileBridgeSyncEnabled, setMobileBridgeSyncEnabled] = useState(false);
  const lastMobileSyncPayloadRef = useRef('');

  const mountCardInBackground = useCallback((cardId: string) => {
    if (mountedIdsRef.current.has(cardId)) return;
    mountedIdsRef.current.add(cardId);
    bumpRender((n) => n + 1);
  }, []);

  const focusedCard = useMemo(
    () => (focusedCardId ? cards.find((c) => c.id === focusedCardId) : undefined),
    [focusedCardId, cards],
  );

  // Ensure the focused card is marked as "ever mounted".
  useEffect(() => {
    if (!focusedCardId) return;
    if (mountedIdsRef.current.has(focusedCardId)) return;
    mountedIdsRef.current.add(focusedCardId);
    bumpRender((n) => n + 1);
  }, [focusedCardId]);

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
    let changed = false;
    for (const id of mountedIdsRef.current) {
      if (!ids.has(id)) {
        mountedIdsRef.current.delete(id);
        changed = true;
      }
    }
    if (changed) bumpRender((n) => n + 1);
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

  const handleJumpToBlock = useCallback(
    ({ cardId, blockId }: { cardId: string; blockId: string }) => {
      focusCard(cardId);
      setViewMode('focus');
      selectBlock(cardId, blockId);
      setBookmarksOpen(false);
    },
    [focusCard, selectBlock],
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
      if (selectedProjectPath && selectedProjectPath !== options.projectPath) {
        selectProject(options.projectPath);
      }
      setCreateOpen(false);
      focusCard(id);
      setViewMode('focus');
    },
    [createCard, focusCard, selectProject, selectedProjectPath],
  );

  // Stage 5 — let Esc close the bookmarks side panel. Modals (palette /
  // search) own their own Esc handlers; this listener is gated on those
  // being closed so it never steals an Esc keystroke from them.
  useEffect(() => {
    if (!bookmarksOpen || paletteOpen || searchOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setBookmarksOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [bookmarksOpen, paletteOpen, searchOpen]);

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
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground sm:inline hidden">
            {t('app.count', { visible: visibleCards.length, total: cards.length, count: cards.length })}
          </span>
        </div>
        <div className="flex items-center gap-1">
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
              onClick={() => setBookmarksOpen((v) => !v)}
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

      {/* Main body — grid + all ever-mounted terminal views share the same
          container; only the focused one is visible. This is what keeps the
          PTY alive across navigation so CLIs don't re-initialise. */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
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
            onCreateTerminal={() => setCreateOpen(true)}
            onOpenTerminal={handleOpenTerminal}
          />
        </motion.div>

        {/* Persistent terminal views */}
        {cards
          .filter((c) => mountedIdsRef.current.has(c.id))
          .map((c) => {
            const isCurrent = viewMode === 'focus' && focusedCardId === c.id;
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
                    BOOKMARKS_VISIBLE ? () => setBookmarksOpen((v) => !v) : undefined
                  }
                  onOpenWorkflows={handleOpenWorkflowPalette}
                  onOpenSettings={handleOpenSettings}
                />
              </div>
            );
          })}
      </div>

      {/* Shortcut hint — dismissible. Anchored to the LEFT so it can't
          overlap with the right-side BlockInspector / Bookmarks panel,
          and hidden whenever a modal/panel is open so it never sits on
          top of overlay UI. */}
      {cards.length > 0 && !hintDismissed && !bookmarksOpen && !paletteOpen && !searchOpen && (
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

      {/* Bookmarks side panel — slides in from the right edge of the workspace.
          Hidden behind the BOOKMARKS_VISIBLE feature flag so the surface
          disappears together with the top toolbar button / hover star / chip. */}
      {BOOKMARKS_VISIBLE && bookmarksOpen && (
        <div className="absolute right-0 top-0 bottom-0 z-30 w-72 border-l border-white/10 bg-background/90 backdrop-blur-2xl shadow-studio">
          <BookmarksSidebar
            onJump={handleJumpToBlock}
            onClose={() => setBookmarksOpen(false)}
          />
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
