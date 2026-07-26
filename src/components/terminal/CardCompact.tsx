import { motion, useReducedMotion } from 'framer-motion';
import { memo } from 'react';
import type { TerminalCard as TerminalCardType } from '../../types/terminal';
import type { CardPreview as CardPreviewData } from './cardPreview';
import { isTechnicalPreviewLine } from './cardPreview';
import { getTerminalTypeMeta } from './terminalTypeMeta';
import { CardStatusBadge } from './CardStatusBadge';

export interface CardCompactProps {
  card: TerminalCardType;
  preview: CardPreviewData;
  isFocused: boolean;
  isSwitcherSelected: boolean;
  onClick?: () => void;
}

export const CardCompact = memo(function CardCompact({
  card,
  preview,
  isFocused,
  isSwitcherSelected,
  onClick,
}: CardCompactProps) {
  const reduceMotion = useReducedMotion();
  const typeMeta = getTerminalTypeMeta(card.terminalType);
  const TypeIcon = typeMeta.Icon;

  return (
    <motion.div
      onClick={onClick}
      whileHover={reduceMotion ? undefined : { scale: 1.015 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.14, ease: 'easeOut' }}
      className={[
        'relative flex h-32 w-40 flex-col overflow-hidden rounded-lg border text-card-foreground shadow-sm transition-colors duration-150',
        isSwitcherSelected
          ? 'border-primary/50 bg-background/90 shadow-sm ring-1 ring-primary/20'
          : isFocused
            ? 'border-primary/40 bg-card/95 shadow-sm'
            : 'border-border/60 bg-card/90 hover:border-border hover:bg-card',
      ].join(' ')}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 backdrop-blur-sm">
        <TypeIcon className={`h-3.5 w-3.5 ${typeMeta.accent}`} />
        <span className="truncate text-[11px] font-medium">{card.projectName}</span>
        <CardStatusBadge status={card.status} size="compact" />
      </div>
      <div className="flex-1 overflow-hidden px-2 py-1 text-[11px] text-muted-foreground leading-tight">
        {preview.bodyLines.length > 0 ? (
          <div className="space-y-1">
            {preview.bodyLines.map((line, index) => (
              <div
                key={`${line}-${index}`}
                className={[
                  'line-clamp-1 rounded-sm',
                  isTechnicalPreviewLine(line) ? 'font-mono text-[11px]' : '',
                ].join(' ')}
              >
                {line}
              </div>
            ))}
          </div>
        ) : (
          <span className="italic opacity-70">—</span>
        )}
      </div>
    </motion.div>
  );
});
