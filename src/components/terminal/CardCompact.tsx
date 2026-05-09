import { motion } from 'framer-motion';
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

export function CardCompact({
  card,
  preview,
  isFocused,
  isSwitcherSelected,
  onClick,
}: CardCompactProps) {
  const typeMeta = getTerminalTypeMeta(card.terminalType);
  const TypeIcon = typeMeta.Icon;

  return (
    <motion.div
      onClick={onClick}
      whileHover={{ scale: 1.04 }}
      className={[
        'relative flex h-32 w-40 flex-col overflow-hidden rounded-[var(--radius)] border text-card-foreground shadow-sm cursor-pointer transition-all duration-300',
        isSwitcherSelected
          ? 'border-primary/50 bg-background/80 shadow-[0_12px_24px_-8px_rgba(0,0,0,0.4)] ring-1 ring-primary/20 scale-[1.05]'
          : isFocused
            ? 'border-primary/40 bg-white/10 backdrop-blur-md shadow-md'
            : 'border-white/5 bg-white/5 backdrop-blur-md hover:border-white/20 hover:bg-white/10',
      ].join(' ')}
    >
      <div className="flex items-center gap-1.5 border-b border-white/5 px-2 py-1.5 backdrop-blur-sm">
        <TypeIcon className={`h-3.5 w-3.5 ${typeMeta.accent}`} />
        <span className="truncate text-[11px] font-medium">{card.projectName}</span>
        <CardStatusBadge status={card.status} size="compact" />
      </div>
      <div className="flex-1 overflow-hidden px-2 py-1 text-[10px] text-muted-foreground leading-tight">
        {preview.bodyLines.length > 0 ? (
          <div className="space-y-1">
            {preview.bodyLines.map((line, index) => (
              <div
                key={`${line}-${index}`}
                className={[
                  'line-clamp-1 rounded-[var(--radius-sm)]',
                  isTechnicalPreviewLine(line) ? 'font-mono text-[9.5px]' : '',
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
}
