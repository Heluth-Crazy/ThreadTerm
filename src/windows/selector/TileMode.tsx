/**
 * TileMode — centered responsive grid of pinned cards.
 *
 * Layout rules:
 *   • 1 card    → single huge hero card (lead size)
 *   • 2 cards   → horizontal pair
 *   • 3 cards   → 3-up row
 *   • 4-6 cards → 2×3 / 3×2 grid (grid-cols follows card count)
 *
 * Stagger animation on entry: cards appear from the centre outward so the
 * selector feels like an explosive reveal.
 */
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import type { TerminalCard } from '../../types/terminal';
import { SelectorCard } from './SelectorCard';

export interface TileModeProps {
  cards: TerminalCard[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onConfirm: (index: number) => void;
}

function gridClassForCount(n: number): string {
  if (n <= 1) return 'grid-cols-1';
  if (n === 2) return 'grid-cols-2';
  if (n === 3) return 'grid-cols-3';
  if (n === 4) return 'grid-cols-2';
  // 5 or 6 → 3 columns
  return 'grid-cols-3';
}

export function TileMode({ cards, selectedIndex, onSelect, onConfirm }: TileModeProps) {
  const { t } = useTranslation('overlay');
  const n = cards.length;
  if (n === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="rounded-2xl border border-white/10 bg-black/40 px-8 py-6 text-center text-white/80 backdrop-blur-md">
          <div className="text-lg font-semibold">{t('selector.emptyTitle')}</div>
          <div className="mt-2 text-sm opacity-80">
            {t('selector.emptyDescription')}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center px-12 py-8">
      <motion.div
        className={`grid gap-6 ${gridClassForCount(n)}`}
        initial="hidden"
        animate="visible"
        variants={{
          hidden: {},
          visible: {
            transition: {
              staggerChildren: 0.045,
              delayChildren: 0.04,
            },
          },
        }}
      >
        {cards.map((card, i) => (
          <motion.div
            key={card.id}
            variants={{
              hidden: { opacity: 0, scale: 0.6, y: 30 },
              visible: {
                opacity: 1,
                scale: 1,
                y: 0,
                transition: { type: 'spring', damping: 20, stiffness: 240 },
              },
            }}
          >
            <SelectorCard
              card={card}
              selected={i === selectedIndex}
              indexLabel={i < 9 ? i + 1 : null}
              size={n === 1 ? 'lead' : 'tile'}
              onClick={() => onSelect(i)}
              onDoubleClick={() => onConfirm(i)}
            />
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
