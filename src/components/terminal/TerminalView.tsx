/**
 * TerminalView — full-screen view for a single terminal card.
 *
 * Uses the existing Shell.jsx component in `isPlainShell` + `autoConnect`
 * mode, passing the card's PTY id so the main window and floating overlay
 * attach to the same Rust PTY session.
 *
 * Animations: shared `layoutId` with the card in the grid produces a
 * smooth expand/collapse transition courtesy of Framer Motion.
 *
 * Stage 4 additions (block layer):
 *   • BlockOverlay — decorations + hover toolbar, shown only when blocks exist
 *   • BlockInspector — right side panel, toggled via the Layers button
 *   • Keyboard shortcuts: Cmd/Ctrl+Shift+\ (prev failed), Cmd/Ctrl+Shift+/
 *     (next failed)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Block } from '../../types/terminal';
import { ArrowLeft, Layers, MoreVertical, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Shell from '../Shell';
import type { TerminalCard } from '../../types/terminal';
import { useTerminalStore } from '../../stores/terminalStore';
import { invoke, isTauriEnv, mobileBridge } from '../../lib/tauri-bridge';
import type { AiExplainProvider } from '../../lib/ai/aiExplain';
import { getStatusMeta } from './statusMeta';
import { getTerminalTypeMeta } from './terminalTypeMeta';
import {
  AI_CLI_SESSION_BADGE_CLASS,
  buildTerminalLaunchCommand,
  getAiCliSessionBadge,
} from './providerSession';
import { useProviderSessionLifecycle } from './useProviderSessionLifecycle';
import { AiIntentSelect } from './AiIntentSelect';
import { BlockOverlay } from './BlockOverlay';
import { BlockInspector } from './BlockInspector';
import { prevFailedBlock, nextFailedBlock } from './failedBlockNav';
import { BottomActionBar } from '../bottombar/BottomActionBar';
import { buildChipRegistry, type ChipId } from '../bottombar/chipRegistry';
import { open as openInShell } from '@tauri-apps/plugin-shell';
import { AutoRestartControls } from './AutoRestartControls';
import { AutoRestartStatus } from './AutoRestartStatus';
import { normalizeAutoRestartConfig } from '../../lib/autoRestart';

interface TerminalViewProps {
  card: TerminalCard;
  active?: boolean;
  onBack: () => void;
  /** Toggle the bookmarks side panel. Wired by `TerminalManager`. */
  onOpenBookmarks?: () => void;
  /** Open the command palette on the workflow group. */
  onOpenWorkflows?: () => void;
  /** Open the Settings modal, optionally on a specific tab. */
  onOpenSettings?: (tab?: 'appearance' | 'shortcuts') => void;
}

export function TerminalView({
  card,
  active = true,
  onBack,
  onOpenBookmarks,
  onOpenWorkflows,
  onOpenSettings,
}: TerminalViewProps) {
  const { t } = useTranslation('terminal');
  const removeCard = useTerminalStore((s) => s.removeCard);
  const recordUserSubmit = useTerminalStore((s) => s.recordUserSubmit);
  const markCardRead = useTerminalStore((s) => s.markCardRead);
  // Stable empty-array fallback so Zustand selector doesn't return a new []
  // reference on every render when no blocks exist yet.
  const emptyBlocksRef = useRef<Block[]>([]);
  const blocks = useTerminalStore(
    (s) => s.blocks?.[card.id] ?? emptyBlocksRef.current,
  );
  const selectedBlockId = useTerminalStore(
    (s) => s.selectedBlockId?.[card.id] ?? null,
  );
  const selectBlock = useTerminalStore((s) => s.selectBlock);
  const aiExplainDefaultProvider = useTerminalStore((s) => s.aiExplainDefaultProvider);
  const bottomBarHidden = useTerminalStore((s) => s.bottomBarHidden);
  const addBookmark = useTerminalStore((s) => s.addBookmark);
  const setCardAutoRestartEnabled = useTerminalStore((s) => s.setCardAutoRestartEnabled);
  const setCardAutoRestartMaxRetries = useTerminalStore((s) => s.setCardAutoRestartMaxRetries);

  const [inspectorOpen, setInspectorOpen] = useState(false);

  // Note: no PTY guard is needed even when the float window also hosts
  // this card. Both windows share the same pty id and the
  // Rust backend makes pty_create idempotent, so both xterm instances
  // simply mirror the same session's output stream.

  const typeMeta = getTerminalTypeMeta(card.terminalType);
  const statusInfo = getStatusMeta(card.status);
  const StatusIcon = statusInfo.Icon;
  const TypeIcon = typeMeta.Icon;
  const autoRestart = normalizeAutoRestartConfig(card.autoRestart);
  const paneId = card.ptyId || card.id;
  const aiSessionBadge = useMemo(
    () => getAiCliSessionBadge(card),
    [
      card.command,
      card.lastOutput,
      card.providerSessionId,
      card.providerSessionState,
      card.terminalType,
    ],
  );

  // Treat the card's optional `command` as an initial command to execute
  // in the PTY right after spawn.
  const launch = useMemo(
    () => buildTerminalLaunchCommand(card, typeMeta.defaultCommand),
    [card, typeMeta.defaultCommand],
  );
  const initialCommand = launch.command;
  const onProviderInitialCommandSent = useProviderSessionLifecycle(card, launch, active);

  const recordSubmit = useCallback(() => {
    recordUserSubmit(card.id, t('view.sentInput'));
  }, [card.id, recordUserSubmit, t]);

  const handleInitialCommandSent = useCallback(() => {
    recordSubmit();
    onProviderInitialCommandSent();
  }, [onProviderInitialCommandSent, recordSubmit]);

  const selectedProject = useMemo(
    () => ({
      name: card.projectName,
      path: card.projectPath,
      fullPath: card.worktreePath || card.projectPath,
    }),
    [card.projectName, card.projectPath, card.worktreePath],
  );

  useEffect(() => {
    if (active && card.unread) {
      markCardRead(card.id);
    }
  }, [active, card.id, card.unread, markCardRead]);

  const handleClose = () => {
    removeCard(card.id);
    onBack();
  };

  // ── Block layer: failed block keyboard navigation ─────────────────────────
  //
  // We read the latest `selectedBlockId` and `blocks` through refs inside the
  // handler so the `keydown` listener is registered exactly once per
  // (active, card.id) pair — without re-registering on every selection
  // change. This eliminates the listener-reattach race the reviewer flagged.

  const blocksRef = useRef(blocks);
  const selectedBlockIdRef = useRef(selectedBlockId);
  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);
  useEffect(() => {
    selectedBlockIdRef.current = selectedBlockId;
  }, [selectedBlockId]);

  useEffect(() => {
    if (!active) return;

    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      const liveBlocks = blocksRef.current;
      if (liveBlocks.length === 0) return;

      if (e.key === '\\' || e.key === '|') {
        e.preventDefault();
        const target = prevFailedBlock(liveBlocks, selectedBlockIdRef.current);
        if (target) selectBlock(card.id, target);
      } else if (e.key === '/' || e.key === '?') {
        e.preventDefault();
        const target = nextFailedBlock(liveBlocks, selectedBlockIdRef.current);
        if (target) selectBlock(card.id, target);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, card.id, selectBlock]);

  // Esc closes the Block Inspector when it's open. Gated on `active` so the
  // listener is only on the foreground card, and on `inspectorOpen` so it
  // never steals Esc from a CLI underneath when the panel is hidden.
  useEffect(() => {
    if (!active || !inspectorOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setInspectorOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, inspectorOpen]);

  // Selected block object for the inspector
  const selectedBlock = useMemo(
    () => blocks.find((b) => b.id === selectedBlockId) ?? null,
    [blocks, selectedBlockId],
  );

  // Auto-select the most recent block when the inspector opens with no
  // existing selection. Without this users see "Select a block to inspect"
  // and have to guess that they need to hover/click an in-terminal block
  // header to populate the panel.
  useEffect(() => {
    if (!inspectorOpen) return;
    if (selectedBlockId) return;
    if (blocks.length === 0) return;
    selectBlock(card.id, blocks[blocks.length - 1].id);
  }, [inspectorOpen, selectedBlockId, blocks, card.id, selectBlock]);

  const hasBlocks = blocks.length > 0;

  // Stage 6 — if the focused card already is an AI CLI, invoke that provider
  // directly; otherwise fall back to the global default (user-visible in the
  // Settings tab in Stage 8 — v1 exposes only the store-level value).
  const providerOverride: AiExplainProvider = useMemo(() => {
    const type = card.terminalType;
    if (type === 'claude' || type === 'codex' || type === 'gemini') return type;
    return aiExplainDefaultProvider;
  }, [card.terminalType, aiExplainDefaultProvider]);

  const handleRunCommand = useCallback(
    (command: string) => {
      // Blocks only fire on shell cards (OSC 133 isn't emitted by AI CLIs),
      // so injection is always into a shell PTY. Append a newline so the
      // shell actually executes the command.
      void invoke('pty_input', { id: paneId, data: `${command}\n` });
    },
    [paneId],
  );

  // ── Stage 6 — bottom chip strip (Decision 5) ────────────────────────────
  const cardCwd = card.worktreePath ?? card.projectPath ?? '';
  const unreadNotifications = useTerminalStore((s) => s.getUnreadCount());
  const bookmarkCount = useTerminalStore(
    (s) => s.bookmarks.filter((b) => b.cardId === card.id).length,
  );
  const [bridgeAvailable, setBridgeAvailable] = useState(false);
  useEffect(() => {
    if (!active || !isTauriEnv()) {
      setBridgeAvailable(false);
      return;
    }

    let cancelled = false;
    void mobileBridge
      .status()
      .then((status) => {
        if (!cancelled) {
          setBridgeAvailable(status.running);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBridgeAvailable(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [active]);
  const bottomBarChips = useMemo(
    () =>
      buildChipRegistry({
        cardCwd,
        bridgeAvailable,
        bookmarkCount,
        unreadNotifications,
      }),
    [bridgeAvailable, bookmarkCount, cardCwd, unreadNotifications],
  );

  const [placeholder, setPlaceholder] = useState<null | 'rich-input'>(null);

  const handleChipActivate = useCallback(
    (id: ChipId) => {
      switch (id) {
        case 'notifications':
          useTerminalStore.getState().toggleNotificationCentre();
          return;
        case 'bookmarks':
          onOpenBookmarks?.();
          return;
        case 'workflows':
          onOpenWorkflows?.();
          return;
        case 'file-explorer': {
          if (!cardCwd) return;
          void openInShell(cardCwd).catch(() => {
            // Non-existent path or denied scope — surface nothing; the chip
            // is best-effort. Future: tie into the toast layer once one ships.
          });
          return;
        }
        case 'rich-input':
          setPlaceholder('rich-input');
          return;
        case 'remote-control':
          onOpenSettings?.('shortcuts');
          return;
      }
    },
    [cardCwd, onOpenBookmarks, onOpenSettings, onOpenWorkflows],
  );

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            title={t('view.backToGrid')}
            className="rounded-lg p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-muted ${typeMeta.accent}`}>
            <TypeIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{card.projectName}</span>
              <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
                · {t(`types.${card.terminalType}`, typeMeta.label)}
              </span>
            </div>
            <div className="truncate text-[10px] text-muted-foreground" title={card.projectPath}>
              {card.worktreePath ? t('view.worktree', { path: card.worktreePath }) : card.projectPath}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-1.5">
          {aiSessionBadge && (
            <AiIntentSelect cardId={card.id} value={card.aiIntent} compact />
          )}
          {aiSessionBadge && (
            <span
              title={t(aiSessionBadge.descriptionKey, {
                ...aiSessionBadge.values,
                defaultValue: aiSessionBadge.fallbackDescription,
              })}
              className={[
                'hidden max-w-[190px] items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none sm:inline-flex',
                AI_CLI_SESSION_BADGE_CLASS[aiSessionBadge.tone],
              ].join(' ')}
            >
              <span className="truncate">
                {t(aiSessionBadge.labelKey, {
                  ...aiSessionBadge.values,
                  defaultValue: aiSessionBadge.fallbackLabel,
                })}
              </span>
            </span>
          )}
          <AutoRestartControls
            enabled={autoRestart.enabled}
            maxRetries={autoRestart.maxRetries}
            onToggle={() =>
              setCardAutoRestartEnabled(card.id, !autoRestart.enabled)
            }
            onMaxRetriesChange={(value) =>
              setCardAutoRestartMaxRetries(card.id, value)
            }
          />
          <AutoRestartStatus card={card} compact />
          <span
            className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${statusInfo.chip}`}
          >
            <StatusIcon className={`h-3 w-3 ${statusInfo.animate ? 'animate-spin' : ''}`} />
            {t(`status.${card.status}`, statusInfo.label)}
          </span>

          {/* Block Inspector toggle — only shown when block data is present */}
          {hasBlocks && (
            <button
              type="button"
              title={t('block.inspector.title', { defaultValue: 'Block Inspector' })}
              onClick={() => setInspectorOpen((v) => !v)}
              className={[
                'rounded-lg p-1.5',
                inspectorOpen
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-accent hover:text-accent-foreground',
              ].join(' ')}
            >
              <Layers className="h-4 w-4" />
            </button>
          )}

          <div className="group relative">
            <button
              type="button"
              className="rounded-lg p-1.5 hover:bg-accent hover:text-accent-foreground"
              title={t('view.more')}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            <div className="absolute right-0 top-full z-10 mt-1 hidden w-44 rounded-lg border border-border bg-popover p-1 text-sm shadow-lg group-hover:block">
              <button
                type="button"
                onClick={handleClose}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" /> {t('view.closeTerminal')}
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onBack}
            title={t('view.close')}
            className="rounded-lg p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Main area: xterm + optional Block Inspector side panel */}
      <div className="flex min-h-0 flex-1">
        {/* xterm — always mounted; shares the PTY with the float window if present */}
        <div
          id={`terminal-shell-${card.id}`}
          className="relative min-h-0 flex-1 bg-[var(--terminal-background)]"
        >
          <Shell
            selectedProject={selectedProject}
            initialCommand={initialCommand}
            minimal={true}
            autoConnect={true}
            paneId={paneId}
            active={active}
            preservePtyOnUnmount={true}
            replayRecentOutput={true}
            suppressInitialCommandWhenPtyExists={true}
            autoReconnectOnExit={false}
            onInitialCommandSent={handleInitialCommandSent}
            onUserSubmit={recordSubmit}
            onProcessComplete={undefined}
            onDisconnect={undefined}
          />

          {/* Block boundary decorations + hover toolbar overlay.
              `overflow-hidden` is intentionally absent here — clipping the
              wrapper would hide a toolbar that anchors to a block near the
              top edge of the viewport. The inner xterm canvas handles its
              own clipping. */}
          {hasBlocks && (
            <div className="pointer-events-none absolute inset-0">
              <BlockOverlay
                cardId={card.id}
                ptyId={paneId}
                blocks={blocks}
                inspectorOpen={inspectorOpen}
              />
            </div>
          )}
        </div>

        {/* Block Inspector side panel */}
        {inspectorOpen && hasBlocks && (
          <div className="w-52 shrink-0 overflow-hidden border-l border-border bg-background">
            {selectedBlock ? (
              <BlockInspector
                block={selectedBlock}
                onClose={() => setInspectorOpen(false)}
                providerOverride={providerOverride}
                onRunCommand={handleRunCommand}
              />
            ) : (
              <div className="flex h-full flex-col">
                <div className="flex items-center border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>
                    {t('block.inspector.title', { defaultValue: 'Block Inspector' })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setInspectorOpen(false)}
                    title={t('common.close', { defaultValue: 'Close' })}
                    aria-label={t('common.close', { defaultValue: 'Close' })}
                    className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex flex-1 items-center justify-center p-3 text-center text-[11px] text-muted-foreground">
                  {t('block.inspector.noBlock', { defaultValue: 'Select a block to inspect' })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Stage 6 — focus-mode bottom chip strip. Hidden by a global setting. */}
      {!bottomBarHidden && (
        <BottomActionBar
          chips={bottomBarChips}
          onChipActivate={handleChipActivate}
        />
      )}

      {placeholder !== null && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid={`bottom-bar-placeholder-${placeholder}`}
          className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 p-4"
          onClick={() => setPlaceholder(null)}
        >
          <div
            className="max-w-sm rounded-xl border border-border bg-popover p-4 text-sm shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <p>
              {t('bottomBar.richInputComingSoon', {
                defaultValue: 'Rich input arrives in Stage 9.',
              })}
            </p>
            <button
              type="button"
              onClick={() => setPlaceholder(null)}
              className="mt-3 inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1.5 text-[11px] font-medium hover:bg-accent hover:text-accent-foreground"
            >
              {t('common.close', { defaultValue: 'Close' })}
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
        <span>
          id:&nbsp;<span className="font-mono">{card.id.slice(0, 10)}</span>
        </span>
        <span>
          {t('view.footer', {
            count: card.messageCount,
            time: new Date(card.createdAt).toLocaleTimeString(),
          })}
        </span>
      </div>
    </div>
  );
}
