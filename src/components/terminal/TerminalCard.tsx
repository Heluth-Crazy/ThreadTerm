/**
 * TerminalCard — rich card component.
 *
 * Shows (per plan §4.1 "丰富版卡片"):
 *   • terminal-type icon + project name + live status chip
 *   • project path + worktree badge
 *   • tail of last assistant reply (3-5 lines)
 *   • active duration + message count + "needs attention" hint
 *   • quick-action mini buttons (copy cwd / open dir / close)
 *   • hover-reveal mini timeline of the most recent 5 events
 *
 * Supports 3 layout densities:
 *   - `compact`   used inside the RadialSwitcher (square)
 *   - `grid`      default grid-cell layout (portrait-ish)
 *   - `list`      (reserved for future list-mode)
 */
import { useMemo, useState, type MouseEvent } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  BellRing,
  Copy,
  ExternalLink,
  FolderGit2,
  MessageSquareText,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import type { TerminalCard as TerminalCardType } from '../../types/terminal';
import { getTerminalTypeMeta } from './terminalTypeMeta';
import { getStatusMeta } from './statusMeta';

export interface TerminalCardProps {
  card: TerminalCardType;
  isFocused: boolean;
  isSwitcherSelected?: boolean;
  density?: 'compact' | 'grid';
  onClick?: () => void;
  onDoubleClick?: () => void;
  onClose?: () => void;
  onCopyCwd?: () => void;
  onOpenDir?: () => void;
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

function formatRelative(at: number): string {
  const d = Date.now() - at;
  if (d < 60_000) return 'just now';
  return `${formatDuration(d)} ago`;
}

export function TerminalCardComponent({
  card,
  isFocused,
  isSwitcherSelected = false,
  density = 'grid',
  onClick,
  onDoubleClick,
  onClose,
  onCopyCwd,
  onOpenDir,
}: TerminalCardProps) {
  const [timelineOpen, setTimelineOpen] = useState(false);
  const typeMeta = getTerminalTypeMeta(card.terminalType);
  const statusInfo = getStatusMeta(card.status);
  const StatusIcon = statusInfo.Icon;
  const TypeIcon = typeMeta.Icon;

  const activeFor = useMemo(
    () => formatDuration(Math.max(0, card.lastActivity - card.createdAt)),
    [card.lastActivity, card.createdAt],
  );

  const replyLines = useMemo(() => {
    if (!card.lastReplyPreview) return [] as string[];
    return card.lastReplyPreview
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      .slice(-5);
  }, [card.lastReplyPreview]);

  const recentEvents = useMemo(() => card.events.slice(-5).reverse(), [card.events]);

  const attentionHint =
    card.status === 'waiting'
      ? '需人工介入'
      : card.status === 'failed'
        ? '发生错误'
        : card.unread
          ? '有新活动'
          : null;

  const stopPropagation = (fn?: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn?.();
  };

  // ── compact layout (used in switcher) ─────────────────────────────────────
  if (density === 'compact') {
    return (
      <motion.div
        onClick={onClick}
        whileHover={{ scale: 1.04 }}
        className={[
          'relative flex h-32 w-40 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm cursor-pointer',
          isSwitcherSelected
            ? 'border-primary ring-2 ring-primary/40'
            : isFocused
              ? 'border-primary/60'
              : 'border-border',
        ].join(' ')}
      >
        <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
          <TypeIcon className={`h-3.5 w-3.5 ${typeMeta.accent}`} />
          <span className="truncate text-[11px] font-medium">{card.projectName}</span>
          <StatusIcon
            className={`ml-auto h-3 w-3 ${statusInfo.tone} ${statusInfo.animate ? 'animate-spin' : ''}`}
          />
        </div>
        <div className="flex-1 overflow-hidden px-2 py-1 text-[10px] font-mono text-muted-foreground leading-tight">
          {card.lastOutput
            .split('\n')
            .filter((l) => l.trim())
            .slice(-3)
            .join('\n') || '—'}
        </div>
      </motion.div>
    );
  }

  // ── grid layout (default) ─────────────────────────────────────────────────
  return (
    <motion.div
      layoutId={`terminal-card-${card.id}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      whileHover={{ y: -2 }}
      onMouseEnter={() => setTimelineOpen(true)}
      onMouseLeave={() => setTimelineOpen(false)}
      className={[
        'relative flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-shadow cursor-pointer',
        isFocused
          ? 'border-primary/60 ring-2 ring-primary/30 shadow-md'
          : 'border-border hover:shadow-md',
        card.unread ? 'ring-1 ring-amber-400/40' : '',
      ].join(' ')}
    >
      {/* Unread dot */}
      {card.unread && (
        <span className="absolute right-3 top-3 flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>
      )}

      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className={`flex h-7 w-7 items-center justify-center rounded-lg bg-muted ${typeMeta.accent}`}>
          <TypeIcon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{card.projectName}</span>
            <span className="text-[10px] text-muted-foreground">· {typeMeta.label}</span>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="truncate">{card.projectPath}</span>
          </div>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusInfo.chip}`}
        >
          <StatusIcon
            className={`h-2.5 w-2.5 ${statusInfo.animate ? 'animate-spin' : ''}`}
          />
          {statusInfo.label}
        </span>
      </div>

      {/* Worktree badge */}
      {card.worktreePath && (
        <div className="flex items-center gap-1.5 border-b border-border/40 bg-muted/40 px-3 py-1 text-[10px] text-muted-foreground">
          <FolderGit2 className="h-3 w-3" />
          <span className="truncate">worktree: {card.worktreePath}</span>
        </div>
      )}

      {/* Reply preview */}
      <div className="min-h-[88px] flex-1 px-3 py-2">
        {replyLines.length > 0 ? (
          <div className="space-y-0.5 font-mono text-[11px] leading-snug text-muted-foreground">
            {replyLines.map((line, i) => (
              <div key={i} className="truncate">
                {line}
              </div>
            ))}
          </div>
        ) : card.lastOutput ? (
          <pre className="whitespace-pre-wrap break-all text-[11px] leading-snug text-muted-foreground line-clamp-4">
            {card.lastOutput.slice(-320)}
          </pre>
        ) : (
          <div className="text-[11px] italic text-muted-foreground/70">No output yet.</div>
        )}
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 border-t border-border/40 bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Timer className="h-3 w-3" /> {activeFor}
        </span>
        <span className="inline-flex items-center gap-1">
          <MessageSquareText className="h-3 w-3" /> {card.messageCount}
        </span>
        {attentionHint && (
          <span
            className={`ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${
              card.status === 'failed'
                ? 'bg-red-500/10 text-red-500'
                : card.status === 'waiting'
                  ? 'bg-amber-500/10 text-amber-600'
                  : 'bg-amber-500/10 text-amber-600'
            }`}
          >
            {card.status === 'failed' ? (
              <AlertCircle className="h-3 w-3" />
            ) : (
              <BellRing className="h-3 w-3" />
            )}
            {attentionHint}
          </span>
        )}
      </div>

      {/* Quick actions + mini timeline (slide up on hover) */}
      <div className="flex items-center justify-between gap-1 border-t border-border/40 px-2 py-1">
        <div className="flex gap-1">
          <button
            type="button"
            title="Copy path"
            onClick={stopPropagation(onCopyCwd)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Copy className="h-3 w-3" />
          </button>
          <button
            type="button"
            title="Reveal project"
            onClick={stopPropagation(onOpenDir)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        </div>
        <button
          type="button"
          title="Close terminal"
          onClick={stopPropagation(onClose)}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {timelineOpen && recentEvents.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="border-t border-border/40 bg-background/80 px-3 py-1.5 text-[10px] text-muted-foreground"
        >
          <div className="mb-0.5 flex items-center gap-1 font-medium">
            <span>Recent</span>
          </div>
          <ul className="space-y-0.5">
            {recentEvents.map((ev, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span className="shrink-0 text-[9px] text-muted-foreground/70">
                  {formatRelative(ev.at)}
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
