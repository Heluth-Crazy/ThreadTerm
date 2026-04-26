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
import { Bell, BellDot, Plus, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import { CardGrid } from './CardGrid';
import { TerminalView } from './TerminalView';
import { CreateTerminalDialog } from './CreateTerminalDialog';
import { ProjectSidebar } from './ProjectSidebar';
import Settings from '../Settings';
import type { TerminalCreateOptions } from '../../types/terminal';

type ViewMode = 'grid' | 'focus';
type SettingsTab = 'appearance' | 'shortcuts';

declare global {
  interface Window {
    __terminalManager?: {
      openCreate: () => void;
      closeCreate: () => void;
      focusMode: (mode: ViewMode) => void;
      openSettings: (tab?: SettingsTab) => void;
    };
  }
}

export function TerminalManager() {
  const { t } = useTranslation('terminal');
  const cards = useTerminalStore((s) => s.cards);
  const focusedCardId = useTerminalStore((s) => s.focusedCardId);
  const focusCard = useTerminalStore((s) => s.focusCard);
  const createCard = useTerminalStore((s) => s.createCard);
  const selectProject = useTerminalStore((s) => s.selectProject);
  const toggleNotificationCentre = useTerminalStore((s) => s.toggleNotificationCentre);
  const unreadCount = useTerminalStore((s) => s.notifications.filter((n) => !n.read).length);
  const selectedProjectPath = useTerminalStore((s) => s.selectedProjectPath);
  const pendingFocusCardId = useTerminalStore((s) => s.pendingFocusCardId);
  const setPendingFocusCardId = useTerminalStore((s) => s.setPendingFocusCardId);

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
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Jump the Settings modal straight to a particular tab on open.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('shortcuts');

  // Set of card ids whose TerminalView should be kept mounted. A view is
  // added the first time the user focuses the card and is only removed when
  // the card itself is deleted. Using a Set ref (plus forceRender counter)
  // avoids re-mounting when cards array refs change.
  const mountedIdsRef = useRef<Set<string>>(new Set());
  const [, bumpRender] = useState(0);

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

  // Expose imperative API.
  useEffect(() => {
    window.__terminalManager = {
      openCreate: () => setCreateOpen(true),
      closeCreate: () => setCreateOpen(false),
      focusMode: (mode) => setViewMode(mode),
      openSettings: (tab) => {
        setSettingsTab(tab ?? 'shortcuts');
        setSettingsOpen(true);
      },
    };
    return () => {
      delete window.__terminalManager;
    };
  }, []);

  const recentProjects = useMemo(
    () => cards.map((c) => ({ path: c.projectPath, name: c.projectName })),
    [cards],
  );
  const gridVisible = viewMode === 'grid' || !focusedCard;

  return (
    <div className="relative flex h-full w-full">
      <ProjectSidebar />
      <div className="relative flex min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-border bg-background/80 px-3 py-2 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <div className="text-sm font-semibold shrink-0">{t('app.title')}</div>
          {selectedProjectName && (
            <>
              <span className="text-muted-foreground">/</span>
              <span
                className="truncate rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
                title={selectedProjectPath ?? undefined}
              >
                {selectedProjectName}
              </span>
            </>
          )}
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {t('app.count', { visible: visibleCards.length, total: cards.length, count: cards.length })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            title={t('app.newTerminalTitle')}
            className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> {t('app.new')}
          </button>
          <button
            type="button"
            onClick={() => {
              setSettingsTab('shortcuts');
              setSettingsOpen(true);
            }}
            title={t('app.settingsTitle')}
            className="rounded-lg p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => toggleNotificationCentre()}
            title={t('app.notificationsTitle')}
            className="relative rounded-lg p-1.5 hover:bg-accent hover:text-accent-foreground"
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
                />
              </div>
            );
          })}
      </div>

      {/* Shortcut hint */}
      {cards.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 right-3 z-10 select-none rounded-lg border border-border/60 bg-background/80 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur">
          <span className="font-mono">⌘/Ctrl+`</span> {t('app.shortcutHint').split(' · ')[0]} ·{' '}
          <span className="font-mono">⌘/Ctrl+Tab</span> {t('app.shortcutHint').split(' · ')[1]} ·{' '}
          <span className="font-mono">⌘/Ctrl+1-9</span> {t('app.shortcutHint').split(' · ')[2]}
        </div>
      )}

      {/* Create dialog */}
      <CreateTerminalDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
        recentProjects={recentProjects}
      />

      {/* Settings modal — opened via the gear button in the top bar */}
      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialTab={settingsTab}
      />
      </div>
    </div>
  );
}
