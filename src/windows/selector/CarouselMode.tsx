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
        className="relative flex items-center justify-center w-full h-full"
        style={{ perspective: 2000 }}
      >
        {cards.map((card, index) => {
          const offset = circularOffset(index, selectedIndex, n);
          const kind = classifyOffset(offset);
          const size: 'lead' | 'thumb' = kind === 'lead' ? 'lead' : 'thumb';
          const hiddenSide = offset === 0 ? 0 : Math.sign(offset);
          
          // Coverflow geometry
          const translateX = kind === 'hidden' ? hiddenSide * 800 : offset * 280;
          const scale = kind === 'lead' ? 1 : kind === 'near' ? 0.75 : 0.55;
          const rotateY = kind === 'hidden' ? hiddenSide * -45 : offset * -25;
          const translateY = Math.abs(offset) * 20; // Slight dip for side cards
          const opacity = kind === 'lead' ? 1 : kind === 'near' ? 0.8 : 0.3;

          return (
            <motion.div
              key={card.id}
              initial={false}
              animate={{
                opacity: kind === 'hidden' ? 0 : opacity,
                x: translateX,
                y: translateY,
                scale,
                rotateY,
                zIndex: 10 - Math.abs(offset),
                filter: kind === 'lead' ? 'blur(0px)' : kind === 'near' ? 'blur(1px)' : 'blur(4px)',
              }}
              transition={{
                type: 'spring',
                stiffness: 260,
                damping: 26,
                mass: 1,
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

      {/* Progress Dots */}
      <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/5 backdrop-blur-md">
        {cards.map((_, i) => (
          <button
            key={i}
            onClick={() => onSelect(i)}
            className={[
              'h-1.5 rounded-full transition-all duration-300',
              i === selectedIndex ? 'w-6 bg-primary shadow-[0_0_10px_rgba(var(--primary),0.5)]' : 'w-1.5 bg-white/20 hover:bg-white/40',
            ].join(' ')}
            aria-label={`Go to card ${i + 1}`}
          />
        ))}
      </div>
    </div>
  );
}
