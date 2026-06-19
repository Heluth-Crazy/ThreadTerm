/**
 * TerminalCard — rich card host.
 *
 * Layout / event-forwarding only; visual concerns are delegated to:
 *   • CardCompact      — square switcher tile (`density='compact'`)
 *   • CardStatusBadge  — status pill / icon
 *   • CardPreviewPanel — boxed preview body with timer + msg-count meta
 *   • CardActions      — copy / reveal / pin button group
 *
 * The 3 layout densities documented in the original spec are still
 * supported via the `density` prop; only `grid` (default) and `compact`
 * have visual treatments — `list` is reserved for a future iteration.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { FolderGit2 } from 'lucide-react';
import type { TerminalCard as TerminalCardType } from '../../types/terminal';
import { MAX_PINNED_CARDS, useTerminalStore } from '../../stores/terminalStore';
import {
  getAiSessionExportFilename,
  renderAiSessionMarkdown,
  type AiSessionExportSource,
} from '../../lib/ai/exportAiSession';
import { saveAiSessionMarkdownFile } from '../../lib/ai/tauriAiSessionExport';
import { buildCardPreview } from './cardPreview';
import { buildTerminalLaunchCommand, getAiCliSessionBadge } from './providerSession';
import { getTerminalTypeMeta } from './terminalTypeMeta';
import { CardCompact } from './CardCompact';
import { CardFooter } from './CardFooter';
import { CardHeader } from './CardHeader';
import { CardPreviewPanel } from './CardPreviewPanel';
import { normalizeAutoRestartConfig } from '../../lib/autoRestart';

export interface TerminalCardProps {
  card: TerminalCardType;
  isFocused: boolean;
  isSwitcherSelected?: boolean;
  density?: 'compact' | 'grid';
  onClick?: () => void;
  onDoubleClick?: () => void;
  onClose?: () => void;
  onArchive?: () => void;
  onCopyCwd?: () => void;
  onOpenDir?: () => void;
  dragHandle?: ReactNode;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

function formatRelative(
  at: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const d = Date.now() - at;
  if (d < 60_000) return t('card.justNow');
  return t('card.ago', { time: formatDuration(d) });
}

export function TerminalCardComponent({
  card,
  isFocused,
  isSwitcherSelected = false,
  density = 'grid',
  onClick,
  onDoubleClick,
  onClose,
  onArchive,
  onCopyCwd,
  onOpenDir,
  dragHandle,
}: TerminalCardProps) {
  const { t } = useTranslation('terminal');
  const reduceMotion = useReducedMotion();
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [aiSessionExporting, setAiSessionExporting] = useState(false);
  const [aiSessionExportStatus, setAiSessionExportStatus] = useState<'saved' | 'error' | null>(
    null,
  );
  const [editingName, setEditingName] = useState(false);

  // Pin state for the global overlay selector (max MAX_PINNED_CARDS).
  const pinned = useTerminalStore((s) => s.pinnedCardIds.includes(card.id));
  const pinFull = useTerminalStore(
    (s) => !s.pinnedCardIds.includes(card.id) && s.pinnedCardIds.length >= MAX_PINNED_CARDS,
  );
  const pinCard = useTerminalStore((s) => s.pinCard);
  const unpinCard = useTerminalStore((s) => s.unpinCard);
  const setCardAutoRestartEnabled = useTerminalStore((s) => s.setCardAutoRestartEnabled);
  const setCardAutoRestartMaxRetries = useTerminalStore((s) => s.setCardAutoRestartMaxRetries);
  const renameCard = useTerminalStore((s) => s.renameCard);
  const togglePin = () => {
    if (pinned) unpinCard(card.id);
    else pinCard(card.id);
  };
  const autoRestart = normalizeAutoRestartConfig(card.autoRestart);

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

  const activeFor = useMemo(
    () => formatDuration(Math.max(0, card.lastActivity - card.createdAt)),
    [card.lastActivity, card.createdAt],
  );

  const preview = useMemo(
    () => buildCardPreview(card, { maxLines: 14, maxLineLength: 520 }),
    [card.lastReplyPreview, card.lastOutput, card.status, card.terminalType],
  );
  const compactPreview = useMemo(
    () => buildCardPreview(card, { maxLines: 3 }),
    [card.lastReplyPreview, card.lastOutput, card.status, card.terminalType],
  );

  const recentEvents = useMemo(() => card.events.slice(-5).reverse(), [card.events]);
  const exportLaunch = useMemo(
    () => buildTerminalLaunchCommand(card, getTerminalTypeMeta(card.terminalType).defaultCommand),
    [card],
  );
  const canExportAiSession =
    (card.terminalType === 'claude' || card.terminalType === 'codex') &&
    !card.command?.trim() &&
    Boolean(exportLaunch.provider);

  const handleExportAiSession = useCallback(async () => {
    if (!canExportAiSession) return;

    const source: AiSessionExportSource = {
      userIntent: card.aiIntent ?? 'Not set',
      provider: exportLaunch.provider ?? 'unknown',
      sessionId: exportLaunch.providerSessionId ?? card.providerSessionId ?? null,
      startedAt: card.createdAt,
      endedAt: card.lastActivity,
      sourceContext: {
        kind: 'card' as const,
        cardId: card.id,
        projectName: card.projectName,
        projectPath: card.worktreePath ?? card.projectPath,
        launchCommand: exportLaunch.command,
        launchAction: exportLaunch.action,
      },
      messages: [],
    };

    setAiSessionExporting(true);
    setAiSessionExportStatus(null);
    try {
      const result = await saveAiSessionMarkdownFile(
        renderAiSessionMarkdown(source),
        getAiSessionExportFilename(source),
        {
          title: t('aiExport.dialogTitle', { defaultValue: 'Export AI session Markdown' }),
          filterName: t('aiExport.markdownFilter', { defaultValue: 'Markdown' }),
        },
      );
      if (result.kind === 'saved') {
        setAiSessionExportStatus('saved');
      }
    } catch {
      setAiSessionExportStatus('error');
    } finally {
      setAiSessionExporting(false);
    }
  }, [canExportAiSession, card, exportLaunch, t]);

  const attentionHint =
    card.status === 'waiting'
      ? t('card.needsAttention')
      : card.status === 'failed'
        ? t('card.errorOccurred')
        : card.unread
          ? t('card.newActivity')
          : null;

  if (density === 'compact') {
    return (
      <CardCompact
        card={card}
        preview={compactPreview}
        isFocused={isFocused}
        isSwitcherSelected={isSwitcherSelected}
        onClick={onClick}
      />
    );
  }

  return (
    <motion.div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      whileHover={reduceMotion ? undefined : { y: -2, scale: 1.003 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: 'easeOut' }}
      onMouseEnter={() => setTimelineOpen(true)}
      onMouseLeave={() => setTimelineOpen(false)}
      className={[
        'relative flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius)] border border-border/70 bg-card/95 shadow-sm transition-colors duration-150 hover:border-border',
        isFocused ? 'ring-2 ring-primary/40' : '',
        card.unread ? 'ring-1 ring-amber-400/30' : '',
      ].join(' ')}
    >
      {card.unread && (
        <span
          aria-hidden="true"
          className="absolute right-3 top-3 h-2 w-2 rounded-full border border-amber-200 bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.14)]"
        />
      )}

      <CardHeader
        card={card}
        aiSessionBadge={aiSessionBadge}
        dragHandle={dragHandle}
        editing={editingName}
        onStartEdit={() => setEditingName(true)}
        onCommitName={(name) => {
          renameCard(card.id, name);
          setEditingName(false);
        }}
        onCancelEdit={() => setEditingName(false)}
      />

      {card.worktreePath && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-white/5 bg-white/5 px-3 py-1.5 text-[10px] text-muted-foreground backdrop-blur-sm">
          <FolderGit2 className="h-3 w-3" />
          <span className="truncate">{t('card.worktree', { path: card.worktreePath })}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden px-3 py-2">
        <CardPreviewPanel
          preview={preview}
          activeFor={activeFor}
          messageCount={card.messageCount}
        />
      </div>

      <CardFooter
        card={card}
        aiSessionBadge={aiSessionBadge}
        attentionHint={attentionHint}
        onRename={() => setEditingName(true)}
        pinned={pinned}
        pinFull={pinFull}
        onCopyCwd={onCopyCwd}
        onOpenDir={onOpenDir}
        onTogglePin={togglePin}
        onArchive={onArchive}
        autoRestartEnabled={autoRestart.enabled}
        autoRestartMaxRetries={autoRestart.maxRetries}
        onToggleAutoRestart={() =>
          setCardAutoRestartEnabled(card.id, !autoRestart.enabled)
        }
        onChangeAutoRestartMaxRetries={(value) =>
          setCardAutoRestartMaxRetries(card.id, value)
        }
        onExportAiSession={canExportAiSession ? handleExportAiSession : undefined}
        aiSessionExporting={aiSessionExporting}
        aiSessionExportStatus={aiSessionExportStatus}
        onClose={onClose}
      />

      {timelineOpen && recentEvents.length > 0 && (
        <motion.div
          initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.12 }}
          className="pointer-events-none absolute inset-x-0 bottom-10 z-20 border-t border-white/10/40 bg-background/95 px-3 py-1.5 text-[10px] text-muted-foreground shadow-[0_-10px_24px_rgba(0,0,0,0.08)] backdrop-blur"
        >
          <div className="mb-0.5 flex items-center gap-1 font-medium">
            <span>{t('card.recent')}</span>
          </div>
          <ul className="space-y-0.5">
            {recentEvents.map((ev, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span className="shrink-0 text-[9px] text-muted-foreground/70">
                  {formatRelative(ev.at, t)}
                </span>
                <span className="truncate">{ev.summary}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      )}
    </motion.div>
  );
}
