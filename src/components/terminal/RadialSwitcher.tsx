/**
 * RadialSwitcher — dandelion-style card picker.
 *
 * Triggered via the global keyboard bridge (Ctrl+` by default). When visible,
 * it darkens the backdrop and bursts compact cards outward from the screen
 * centre along evenly-distributed angles. Keyboard navigation:
 *
 *   ArrowLeft / ArrowUp        → previous
 *   ArrowRight / ArrowDown     → next
 *   1-9                        → jump to index (1-indexed)
 *   Enter                      → confirm current selection
 *   Escape                     → close without switching
 *
 * Layout algorithm:
 *   • ≤ 6 cards → single ring
 *   • 7 – 12    → double ring, inner 6 + remainder outer
 *   • > 12      → fall back to a spiral where each card is spaced by
 *                 the golden-angle (≈137.5°) to keep them visually distinct.
 *
 * The switcher intentionally does not own its own `Ctrl+\`` listener — that
 * lives in KeyboardBridge so shortcuts stay in one file. This component
 * only handles navigation keys while it is open and stops propagation so
 * the host terminal (xterm) does not eat them.
 */
import { useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalCardComponent } from './TerminalCard';

interface LaidOutCard {
  id: string;
  x: number;
  y: number;
  angleRad: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.3999 rad
const INNER_RADIUS = 160; // px
const OUTER_RADIUS = 300; // px

function layoutCards(ids: string[]): LaidOutCard[] {
  const n = ids.length;
  if (n === 0) return [];
  const out: LaidOutCard[] = [];

  if (n <= 6) {
    // Single ring.
    const step = (2 * Math.PI) / n;
    // Start at -90° so the first card sits at the top.
    const start = -Math.PI / 2;
    for (let i = 0; i < n; i++) {
      const a = start + i * step;
      out.push({
        id: ids[i],
        x: Math.cos(a) * INNER_RADIUS,
        y: Math.sin(a) * INNER_RADIUS,
        angleRad: a,
      });
    }
  } else if (n <= 12) {
    // Inner ring of 6, outer ring of the remainder.
    const inner = ids.slice(0, 6);
    const outer = ids.slice(6);
    const innerStep = (2 * Math.PI) / 6;
    const innerStart = -Math.PI / 2;
    inner.forEach((id, i) => {
      const a = innerStart + i * innerStep;
      out.push({
        id,
        x: Math.cos(a) * INNER_RADIUS,
        y: Math.sin(a) * INNER_RADIUS,
        angleRad: a,
      });
    });
    const outerStep = (2 * Math.PI) / outer.length;
    // Stagger outer ring so cards don't line up with inner ring.
    const outerStart = -Math.PI / 2 + outerStep / 2;
    outer.forEach((id, i) => {
      const a = outerStart + i * outerStep;
      out.push({
        id,
        x: Math.cos(a) * OUTER_RADIUS,
        y: Math.sin(a) * OUTER_RADIUS,
        angleRad: a,
      });
    });
  } else {
    // Golden-angle spiral.
    ids.forEach((id, i) => {
      const a = i * GOLDEN_ANGLE;
      // Radius grows slowly so cards stay on screen for reasonable n.
      const r = INNER_RADIUS + Math.sqrt(i) * 40;
      out.push({
        id,
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        angleRad: a,
      });
    });
  }
  return out;
}

export function RadialSwitcher() {
  const visible = useTerminalStore((s) => s.switcherVisible);
  const cards = useTerminalStore((s) => s.cards);
  const selectedIndex = useTerminalStore((s) => s.switcherSelectedIndex);
  const focusedCardId = useTerminalStore((s) => s.focusedCardId);

  const closeSwitcher = useTerminalStore((s) => s.closeSwitcher);
  const confirmSwitcher = useTerminalStore((s) => s.confirmSwitcher);
  const setSelectedIndex = useTerminalStore((s) => s.setSwitcherSelectedIndex);

  const ids = useMemo(() => cards.map((c) => c.id), [cards]);
  const positions = useMemo(() => layoutCards(ids), [ids]);

  // Capture-phase handler so the overlay wins over xterm/input focus.
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => undefined);

  useEffect(() => {
    handlerRef.current = (e: KeyboardEvent) => {
      if (!visible) return;

      // Allow the KeyboardBridge to handle `Ctrl+\`` toggles without us
      // swallowing them. Propagation stops for everything else.
      if (e.key === '`' && (e.ctrlKey || e.metaKey)) return;

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex(selectedIndex + 1);
          return;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex(selectedIndex - 1);
          return;
        case 'Tab':
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex(selectedIndex + (e.shiftKey ? -1 : 1));
          return;
        case 'Enter':
          e.preventDefault();
          e.stopPropagation();
          confirmSwitcher();
          return;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          closeSwitcher();
          return;
        default: {
          const n = Number(e.key);
          if (Number.isFinite(n) && n >= 1 && n <= 9 && cards.length >= n) {
            e.preventDefault();
            e.stopPropagation();
            setSelectedIndex(n - 1);
            confirmSwitcher();
          }
        }
      }
    };
  }, [cards.length, closeSwitcher, confirmSwitcher, selectedIndex, setSelectedIndex, visible]);

  useEffect(() => {
    if (!visible) return;
    const listener = (e: KeyboardEvent) => handlerRef.current(e);
    window.addEventListener('keydown', listener, { capture: true });
    return () => {
      window.removeEventListener('keydown', listener, { capture: true } as EventListenerOptions);
    };
  }, [visible]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="radial-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={closeSwitcher}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md"
        >
          {/* Centre label */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none text-center text-xs text-white/70">
            <div className="text-[10px] uppercase tracking-widest opacity-60">Switch</div>
            <div className="mt-1 font-mono text-lg">{selectedIndex + 1} / {cards.length}</div>
          </div>

          {/* Cards */}
          {positions.map((p, i) => {
            const card = cards[i];
            if (!card) return null;
            const isSelected = i === selectedIndex;
            return (
              <motion.div
                key={card.id}
                initial={{ opacity: 0, x: 0, y: 0, scale: 0.2 }}
                animate={{
                  opacity: 1,
                  x: p.x,
                  y: p.y,
                  scale: isSelected ? 1.08 : 0.95,
                }}
                exit={{ opacity: 0, x: 0, y: 0, scale: 0.2 }}
                transition={{
                  type: 'spring',
                  damping: 22,
                  stiffness: 280,
                  delay: Math.min(i, 10) * 0.02,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedIndex(i);
                  confirmSwitcher();
                }}
                className="absolute left-1/2 top-1/2"
                style={{ translateX: '-50%', translateY: '-50%' }}
              >
                <TerminalCardComponent
                  card={card}
                  isFocused={card.id === focusedCardId}
                  isSwitcherSelected={isSelected}
                  density="compact"
                />
                <div className="mt-1 text-center text-[10px] text-white/70">
                  {`${i + 1}`}
                </div>
              </motion.div>
            );
          })}

          {/* Help line */}
          <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-[11px] text-white/80">
            ← / → navigate · Enter select · Esc cancel · 1-9 jump
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
