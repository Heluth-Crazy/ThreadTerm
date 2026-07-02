/**
 * BottomActionBar — focus-mode chip strip anchored at the bottom of
 * the focused card view (Stage 6 §Decision 5 / §Task 9).
 *
 * Plan-locked behavior:
 *   • Five chips, ordered notifications → bookmarks → file-explorer
 *     (gated by `cardCwd`) → rich-input → remote-control
 *     (gated by `bridgeAvailable`).
 *   • ArrowLeft / ArrowRight / Home / End move focus among visible
 *     chips; Enter / Space activate.
 *   • ResizeObserver collapses chips that overflow into a `…` menu.
 *   • Single `onChipActivate(id)` callback — strip stays presentational.
 */
import {
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bell,
  BellDot,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  Smartphone,
  Star,
  type LucideIcon,
} from 'lucide-react';
import { buildChipRegistry, type ChipDescriptor, type ChipIconKey, type ChipId } from './chipRegistry';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

interface Props {
  chips: ChipDescriptor[];
  onChipActivate: (id: ChipId) => void;
  className?: string;
}

interface ContextProps extends Omit<Props, 'chips'> {
  cardCwd: string;
  bridgeAvailable: boolean;
  bookmarkCount: number;
  unreadNotifications: number;
}

const STATIC_ICONS: Record<Exclude<ChipIconKey, 'bell'>, LucideIcon> = {
  star: Star,
  folder: FolderOpen,
  message: MessageSquare,
  phone: Smartphone,
};

function pickIcon(chip: ChipDescriptor): LucideIcon {
  if (chip.iconKey === 'bell') return chip.badge && chip.badge > 0 ? BellDot : Bell;
  return STATIC_ICONS[chip.iconKey];
}

export function BottomActionBar({
  chips,
  onChipActivate,
  className,
}: Props) {
  const { t } = useTranslation('terminal');

  const stripRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [overflowCount, setOverflowCount] = useState(0);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const visibleChips = overflowCount > 0 ? chips.slice(0, chips.length - overflowCount) : chips;
  const overflowChips = overflowCount > 0 ? chips.slice(chips.length - overflowCount) : [];

  const recomputeOverflow = useCallback(() => {
    const measure = measureRef.current;
    const strip = stripRef.current;
    if (!measure || !strip) return;
    const buttons = Array.from(measure.querySelectorAll<HTMLButtonElement>('button[data-chip-measure]'));
    if (buttons.length === 0) {
      setOverflowCount(0);
      return;
    }
    const stripWidth = strip.clientWidth;
    if (stripWidth <= 0) return;
    let widths = buttons.map((b) => b.offsetWidth + 4);
    const overflowReserve = 32;
    let total = widths.reduce((a, b) => a + b, 0);
    if (total <= stripWidth) {
      setOverflowCount(0);
      return;
    }
    let drop = 0;
    while (drop < widths.length && total + overflowReserve > stripWidth) {
      total -= widths[widths.length - 1 - drop];
      drop += 1;
    }
    setOverflowCount(drop);
  }, []);

  useLayoutEffect(() => {
    recomputeOverflow();
  }, [chips, recomputeOverflow]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recomputeOverflow());
    ro.observe(strip);
    return () => ro.disconnect();
  }, [recomputeOverflow]);

  const focusableSelector = 'button[data-chip]:not([disabled])';

  const focusByIndex = useCallback((index: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    const items = Array.from(strip.querySelectorAll<HTMLButtonElement>(focusableSelector));
    if (items.length === 0) return;
    const clamped = ((index % items.length) + items.length) % items.length;
    items[clamped]?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const strip = stripRef.current;
      if (!strip) return;
      const items = Array.from(strip.querySelectorAll<HTMLButtonElement>(focusableSelector));
      const currentIdx = items.findIndex((el) => el === document.activeElement);
      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault();
          focusByIndex(currentIdx < 0 ? 0 : currentIdx + 1);
          return;
        case 'ArrowLeft':
          event.preventDefault();
          focusByIndex(currentIdx < 0 ? items.length - 1 : currentIdx - 1);
          return;
        case 'Home':
          event.preventDefault();
          focusByIndex(0);
          return;
        case 'End':
          event.preventDefault();
          focusByIndex(items.length - 1);
          return;
        default:
          return;
      }
    },
    [focusByIndex],
  );

  const renderChipButton = (chip: ChipDescriptor, opts: { measureOnly?: boolean } = {}) => {
    const Icon = pickIcon(chip);
    const label = t(chip.labelKey, { defaultValue: chip.id });
    const measureOnly = opts.measureOnly === true;
    const dataAttr = measureOnly
      ? { 'data-chip-measure': chip.id }
      : { 'data-chip': chip.id, 'data-testid': `chip-${chip.id}` };
    return (
      <button
        key={(measureOnly ? 'm-' : 'v-') + chip.id}
        type="button"
        role="button"
        tabIndex={measureOnly ? -1 : 0}
        aria-hidden={measureOnly || undefined}
        title={measureOnly ? undefined : label}
        aria-label={measureOnly ? undefined : label}
        onClick={measureOnly ? undefined : () => onChipActivate(chip.id)}
        onKeyDown={
          measureOnly
            ? undefined
            : (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onChipActivate(chip.id);
                }
              }
        }
        className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 backdrop-blur-md px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-all duration-200 hover:bg-white/10 hover:text-foreground hover:border-white/20 hover:scale-[1.02] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        {...dataAttr}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        <span>{label}</span>
        {chip.badge && chip.badge > 0 && (
          <span className="ml-1 inline-flex min-w-[1.125rem] h-[1.125rem] items-center justify-center rounded-full bg-primary/20 px-1 text-[9px] font-bold text-primary shadow-sm">
            {chip.badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      data-testid="bottom-action-bar"
      ref={stripRef}
      role="toolbar"
      aria-label={t('bottomBar.label', { defaultValue: 'Focus-mode actions' })}
      onKeyDown={handleKeyDown}
      className={[
        'relative flex shrink-0 items-center gap-1.5 border-t border-white/5 bg-background/60 px-3 py-2 backdrop-blur-xl',
        className ?? '',
      ].join(' ')}
    >
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute inset-y-0 left-0 flex items-center gap-1 px-2">
        {chips.map((chip) => renderChipButton(chip, { measureOnly: true }))}
      </div>

      {visibleChips.map((chip) => renderChipButton(chip))}

      {overflowChips.length > 0 && (
        <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
          <PopoverTrigger
            data-chip="__overflow"
            data-testid="chip-overflow"
            aria-haspopup="menu"
            title={t('bottomBar.overflow', { defaultValue: 'More' })}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 backdrop-blur-md px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-white/10 hover:text-foreground hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
            <span>{t('bottomBar.overflow', { defaultValue: 'More' })}</span>
          </PopoverTrigger>
          <PopoverContent
            role="menu"
            side="top"
            align="end"
            data-testid="chip-overflow-menu"
            className="flex min-w-36 flex-col gap-1"
          >
            {overflowChips.map((chip) => {
              const Icon = pickIcon(chip);
              const label = t(chip.labelKey, { defaultValue: chip.id });
              return (
                <button
                  key={chip.id}
                  type="button"
                  role="menuitem"
                  data-testid={`chip-overflow-${chip.id}`}
                  onClick={() => {
                    setOverflowOpen(false);
                    onChipActivate(chip.id);
                  }}
                  className="inline-flex items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  <span>{label}</span>
                  {chip.badge && chip.badge > 0 && (
                    <span className="ml-auto inline-flex min-w-[1rem] items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] text-primary">
                      {chip.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

export function BottomActionBarForContext({
  cardCwd,
  bridgeAvailable,
  bookmarkCount,
  unreadNotifications,
  ...props
}: ContextProps) {
  const chips = useMemo(
    () => buildChipRegistry({ cardCwd, bridgeAvailable, bookmarkCount, unreadNotifications }),
    [bridgeAvailable, bookmarkCount, cardCwd, unreadNotifications],
  );

  return <BottomActionBar chips={chips} {...props} />;
}
