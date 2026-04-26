/**
 * SelectorCard — single-card tile used by both TileMode and CarouselMode.
 *
 * Visual model (large, readable, high-contrast):
 *   ┌─────────────────────────────┐
 *   │ [icon]  project · type      │  ← header
 *   │ projectPath                 │
 *   │─────────────────────────────│
 *   │ last reply preview           │  ← body
 *   │ ...                          │
 *   │─────────────────────────────│
 *   │ statusChip   ·   5m active   │  ← footer
 *   └─────────────────────────────┘
 *
 * The overlay selector is a separate webview rendered on a transparent/glass
 * background, so cards use an opaque, elevated surface to stay readable on
 * any desktop wallpaper.
 */
import { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import type { TerminalCard } from '../../types/terminal';
import { getTerminalTypeMeta } from '../../components/terminal/terminalTypeMeta';
import { getStatusMeta } from '../../components/terminal/statusMeta';

export interface SelectorCardProps {
  card: TerminalCard;
  selected: boolean;
  indexLabel?: number | null;
  /** Size scale — tile=regular grid; carousel=larger center card. */
  size?: 'tile' | 'lead' | 'thumb';
  onClick?: () => void;
  onDoubleClick?: () => void;
}

function tailLines(input: string, n: number): string[] {
  if (!input) return [];
  return input
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-n);
}

export const SelectorCard = memo(function SelectorCard({
  card,
  selected,
  indexLabel = null,
  size = 'tile',
  onClick,
  onDoubleClick,
}: SelectorCardProps) {
  const { t } = useTranslation('terminal');
  const typeMeta = getTerminalTypeMeta(card.terminalType);
  const statusInfo = getStatusMeta(card.status);
  const StatusIcon = statusInfo.Icon;
  const TypeIcon = typeMeta.Icon;

  const preview = useMemo(
    () => tailLines(card.lastReplyPreview || card.lastOutput, size === 'lead' ? 6 : 3),
    [card.lastReplyPreview, card.lastOutput, size],
  );

  const dims =
    size === 'lead'
      ? 'h-[360px] w-[460px] text-sm'
      : size === 'thumb'
        ? 'h-[160px] w-[220px] text-[11px]'
        : 'h-[220px] w-[280px] text-xs';

  return (
    <motion.div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      whileHover={{ y: -2 }}
      transition={{ type: 'tween', duration: 0.15 }}
      className={[
        'group relative flex flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xl cursor-pointer',
        'backdrop-blur-md',
        dims,
        selected
          ? 'border-primary ring-4 ring-primary/40 shadow-2xl'
          : 'border-border/70 hover:border-primary/50',
      ].join(' ')}
    >
      {/* Index badge (1-9 shortcut hint) */}
      {typeof indexLabel === 'number' && (
        <span
          className={[
            'absolute left-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full',
            'text-[11px] font-mono font-semibold',
            selected
              ? 'bg-primary text-primary-foreground'
              : 'bg-black/50 text-white/90',
          ].join(' ')}
        >
          {indexLabel}
        </span>
      )}

      {/* Unread dot */}
      {card.unread && (
        <span className="absolute right-3 top-3 z-10 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
        </span>
      )}

      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 pb-2 pt-3">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-muted ${typeMeta.accent}`}>
          <TypeIcon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold">{card.projectName}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              · {t(`types.${card.terminalType}`, typeMeta.label)}
            </span>
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{card.projectPath}</div>
        </div>
      </div>

      {/* Preview
       *
       * Rendering rules:
       *   • Use a <pre> block with `whitespace-pre-wrap` so long lines
       *     actually wrap instead of being truncated mid-word.
       *   • Clamp by total visual lines, not by per-row truncation, so a
       *     single long sentence can consume several visual lines and
       *     remain readable end-to-end.
       *   • `break-words` handles the CLI token-soup case (long paths,
       *     JSON blobs) without overflowing the card horizontally.
       */}
      <div className="flex-1 overflow-hidden px-3 py-2">
        {preview.length > 0 ? (
          <pre
            className={[
              'font-mono leading-snug text-muted-foreground',
              'whitespace-pre-wrap break-words',
              size === 'lead' ? 'line-clamp-[10]' : 'line-clamp-6',
            ].join(' ')}
          >
            {preview.join('\n')}
          </pre>
        ) : (
          <div className="italic text-muted-foreground/70">{t('card.noOutput')}</div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t border-border/40 bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${statusInfo.chip}`}
        >
          <StatusIcon
            className={`h-2.5 w-2.5 ${statusInfo.animate ? 'animate-spin' : ''}`}
          />
          {t(`status.${card.status}`, statusInfo.label)}
        </span>
        <span className="ml-auto">
          #{card.messageCount} · {new Date(card.lastActivity).toLocaleTimeString()}
        </span>
      </div>
    </motion.div>
  );
});
