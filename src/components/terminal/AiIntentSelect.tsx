import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { TerminalAiIntent } from '../../types/terminal';
import { useTerminalStore } from '../../stores/terminalStore';
import { AI_INTENTS } from './aiIntent';

interface AiIntentSelectProps {
  cardId: string;
  value?: TerminalAiIntent;
  compact?: boolean;
}

export function AiIntentSelect({ cardId, value, compact = false }: AiIntentSelectProps) {
  const { t } = useTranslation('terminal');
  const updateCardAiIntent = useTerminalStore((s) => s.updateCardAiIntent);
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const options = useMemo(
    () => [
      { value: '' as const, label: t('aiIntent.none') },
      ...AI_INTENTS.map((intent) => ({
        value: intent,
        label: t(`aiIntent.${intent}`),
      })),
    ],
    [t],
  );
  const selectedLabel = options.find((option) => option.value === (value ?? ''))?.label ?? t('aiIntent.none');

  const stop = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const close = () => setOpen(false);

  const syncMenuRect = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = Math.max(rect.width, compact ? 112 : 132);
    const viewportPadding = 8;
    setMenuRect({
      left: Math.min(
        Math.max(viewportPadding, rect.left),
        Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
      ),
      top: rect.bottom + 4,
      width: menuWidth,
    });
  };

  const toggleOpen = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    syncMenuRect();
    setOpen((current) => !current);
  };

  const choose = (next: TerminalAiIntent | '') => (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    updateCardAiIntent(cardId, next || null);
    close();
  };

  useEffect(() => {
    if (!open) return;
    syncMenuRect();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (buttonRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onReposition = () => syncMenuRect();

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, compact]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={t('aiIntent.label')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('aiIntent.label')}
        onClick={toggleOpen}
        onMouseDown={stop}
        className={[
          'inline-flex shrink-0 appearance-none items-center justify-between rounded-[var(--radius-md)] border border-white/10 bg-background text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:ring-2 focus:ring-ring/40',
          compact
            ? 'h-7 w-[104px] gap-1.5 px-2 text-[10px]'
            : 'h-8 w-[132px] gap-2 px-2.5 text-[11px]',
        ].join(' ')}
      >
        <span className="min-w-0 flex-1 truncate text-left leading-none">{selectedLabel}</span>
        <ChevronDown aria-hidden="true" className={compact ? 'h-3 w-3 shrink-0' : 'h-3.5 w-3.5 shrink-0'} />
      </button>
      {open && menuRect && createPortal(
        <div
          ref={menuRef}
          role="menu"
          onClick={stop}
          onMouseDown={stop}
          className="fixed z-[9999] rounded-[var(--radius-md)] border border-white/10 bg-popover p-1 text-xs text-popover-foreground shadow-xl"
          style={{
            left: menuRect.left,
            top: menuRect.top,
            width: menuRect.width,
          }}
        >
          {options.map((option) => {
            const selected = option.value === (value ?? '');
            return (
              <button
                key={option.value || 'none'}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={choose(option.value)}
                className={[
                  'flex w-full items-center justify-between rounded-[var(--radius-md)] px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground',
                  selected ? 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground' : '',
                ].join(' ')}
              >
                <span className="truncate">{option.label}</span>
                {selected && <span className="ml-2 shrink-0">✓</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
