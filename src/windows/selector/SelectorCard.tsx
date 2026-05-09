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
import { buildCardPreview, isTechnicalPreviewLine } from '../../components/terminal/cardPreview';

export interface SelectorCardProps {
  card: TerminalCard;
  selected: boolean;
  indexLabel?: number | null;
  /** Size scale — tile=regular grid; carousel=larger center card. */
  size?: 'tile' | 'lead' | 'thumb';
  onClick?: () => void;
  onDoubleClick?: () => void;
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
  const TypeIcon = typeMeta.Icon;

  const preview = useMemo(
    () => buildCardPreview(card, {
      maxLines: size === 'lead' ? 8 : 4,
      maxLineLength: size === 'lead' ? 520 : 320,
    }),
    [card.lastReplyPreview, card.lastOutput, card.status, card.terminalType, size],
  );
  const previewText = preview.bodyLines.join('\n\n');
  const previewIsProse = preview.source === 'reply' && !preview.bodyLines.some(isTechnicalPreviewLine);
  const previewLineClamp = size === 'lead' ? 10 : size === 'thumb' ? 3 : 5;

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
      whileHover={{ y: -4, scale: size === 'lead' ? 1.01 : 1.05 }}
      transition={{ type: 'spring', damping: 20, stiffness: 300 }}
      className={[
        'group relative flex flex-col overflow-hidden rounded-[var(--radius)] border text-card-foreground transition-all duration-300 cursor-pointer glass-reflection',
        'backdrop-blur-2xl',
        dims,
        selected
          ? 'border-primary/50 bg-background/80 shadow-studio ring-1 ring-primary/20'
          : 'border-white/5 bg-white/5 hover:border-white/20 hover:bg-white/10',
      ].join(' ')}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/5 px-3 pb-2 pt-3 bg-white/5 backdrop-blur-sm">
        <div className={`flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] bg-primary/10 ${typeMeta.accent}`}>
          <TypeIcon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold">{card.projectName}</span>
            <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
              · {t(`types.${card.terminalType}`, typeMeta.label)}
            </span>
            {typeof indexLabel === 'number' && size === 'tile' && (
              <kbd
                className={[
                  'ml-auto shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none shadow-sm',
                  selected
                    ? 'border-primary/30 bg-primary/20 text-primary'
                    : 'border-white/10 bg-white/5 text-muted-foreground',
                ].join(' ')}
              >
                {indexLabel}
              </kbd>
            )}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{card.projectPath}</div>
        </div>
      </div>

      {/* Preview
       *
       * Rendering rules:
       *   • Reuse the main card preview filter so selector cards do not
       *     expose shell prompts, startup noise, or raw TUI redraw text.
       *   • Render prose as one wrapped block so a single long reply can
       *     use the available preview area; keep shell-like output row based.
      */}
      <div className="flex-1 overflow-hidden px-3 py-2">
        {preview.bodyLines.length > 0 ? (
          <div
            className={[
              'leading-snug text-muted-foreground',
              size === 'lead' ? 'text-sm' : 'text-xs',
            ].join(' ')}
          >
            {previewIsProse ? (
              <p
                className="whitespace-pre-wrap break-words"
                style={{
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: previewLineClamp,
                  overflow: 'hidden',
                }}
              >
                {previewText}
              </p>
            ) : (
              <div className="space-y-1">
                {preview.bodyLines.map((line, index) => {
                  const technical = isTechnicalPreviewLine(line);
                  return (
                    <div
                      key={`${line}-${index}`}
                      className={[
                        'break-words',
                        size === 'lead' ? 'line-clamp-2' : 'line-clamp-1',
                        technical ? 'font-mono' : '',
                      ].join(' ')}
                    >
                      {line}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="italic text-muted-foreground/70">{t('card.noOutput')}</div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t border-white/5 bg-white/5 px-3 py-2 text-[10px] text-muted-foreground backdrop-blur-sm">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 font-bold uppercase tracking-wider text-[9px] ${statusInfo.chip} bg-opacity-20`}
        >
          {t(`status.${card.status}`, statusInfo.label)}
        </span>
        <span className="ml-auto">#{card.messageCount}</span>
      </div>
    </motion.div>
  );
});
