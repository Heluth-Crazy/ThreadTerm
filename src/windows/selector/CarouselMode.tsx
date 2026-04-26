/**
 * CarouselMode — coverflow-style card browser centred on the selected card.
 *
 * Visual model:
 *     [thumb] [thumb]  «LEAD CARD»  [thumb] [thumb]
 *
 * The selected card is rendered at lead size in the centre; neighbours are
 * rendered as thumbs and gently rotate / scale away from the focal point.
 * Navigation cycles the selectedIndex with wrap-around.
 */
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import type { TerminalCard } from '../../types/terminal';
import { SelectorCard } from './SelectorCard';

export interface CarouselModeProps {
  cards: TerminalCard[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onConfirm: (index: number) => void;
}

/** Offsets shown on either side of the centre. */
const VISIBLE_NEIGHBOURS = 2;

function classifyOffset(off: number): 'lead' | 'near' | 'far' | 'hidden' {
  const a = Math.abs(off);
  if (a === 0) return 'lead';
  if (a === 1) return 'near';
  if (a <= VISIBLE_NEIGHBOURS) return 'far';
  return 'hidden';
}

function circularOffset(index: number, selectedIndex: number, total: number): number {
  let offset = index - selectedIndex;
  if (offset > total / 2) offset -= total;
  if (offset < -total / 2) offset += total;
  return offset;
}

export function CarouselMode({ cards, selectedIndex, onSelect, onConfirm }: CarouselModeProps) {
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
    <div className="relative flex h-full w-full items-center justify-center">
      <div
        className="relative flex items-center justify-center"
        style={{ perspective: 1400 }}
      >
        {cards.map((card, index) => {
          const offset = circularOffset(index, selectedIndex, n);
          const kind = classifyOffset(offset);
          const size: 'lead' | 'thumb' = kind === 'lead' ? 'lead' : 'thumb';
          const hiddenSide = offset === 0 ? 0 : Math.sign(offset);
          const translateX = kind === 'hidden' ? hiddenSide * 760 : offset * 310;
          const scale = kind === 'lead' ? 1 : kind === 'near' ? 0.78 : 0.6;
          const rotateY = kind === 'hidden' ? hiddenSide * -24 : offset * -10;
          const opacity = kind === 'lead' ? 1 : kind === 'near' ? 0.85 : 0.45;

          return (
            <motion.div
              key={card.id}
              initial={false}
              animate={{
                opacity: kind === 'hidden' ? 0 : opacity,
                x: translateX,
                scale,
                rotateY,
                zIndex: 10 - Math.abs(offset),
                filter: kind === 'lead' ? 'blur(0px)' : kind === 'near' ? 'blur(0.3px)' : 'blur(1px)',
              }}
              transition={{
                type: 'spring',
                stiffness: 210,
                damping: 30,
                mass: 0.9,
              }}
              className="absolute left-1/2 top-1/2"
              style={{
                translateX: '-50%',
                translateY: '-50%',
                transformStyle: 'preserve-3d',
                pointerEvents: kind === 'hidden' ? 'none' : 'auto',
              }}
              onClick={() => {
                if (kind === 'hidden') return;
                if (offset === 0) onConfirm(index);
                else onSelect(index);
              }}
            >
              <SelectorCard
                card={card}
                selected={offset === 0}
                indexLabel={offset === 0 && index < 9 ? index + 1 : null}
                size={size}
              />
            </motion.div>
          );
        })}
      </div>

      {/* Counter below */}
      <div className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-4 py-1.5 font-mono text-xs text-white/90 backdrop-blur">
        {t('selector.counter', { current: selectedIndex + 1, total: n })}
      </div>
    </div>
  );
}
