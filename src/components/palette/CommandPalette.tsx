/**
 * CommandPalette — Cmd/Ctrl+K modal for jumping between cards / blocks /
 * projects and triggering existing actions.
 *
 * Spec (Stage 5.2):
 *   • Single panel, entries grouped by `CommandGroup`.
 *   • No new executable actions — every entry's `run()` is a wrapper
 *     around an existing terminalStore action.
 *   • Keyboard nav (ArrowUp/Down/Enter/Escape) lives in this component;
 *     window listener is registered only when `open=true`.
 *   • No persisted state — closing clears the query.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { fuzzyFilter, type CommandEntry, type CommandGroup } from './commandRegistry';

export interface CommandPaletteProps {
  open: boolean;
  entries: CommandEntry[];
  initialGroup?: CommandGroup | null;
  onClose: () => void;
}

const GROUP_ORDER: CommandGroup[] = [
  'jump-card',
  'jump-block',
  'switch-project',
  'run-workflow',
  'change-intent',
  'toggle-overlay',
  'settings',
];

export function CommandPalette({
  open,
  entries,
  initialGroup = null,
  onClose,
}: CommandPaletteProps) {
  const { t } = useTranslation('terminal');
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Element that had focus before we opened — restored on close so the
   *  user falls back into the underlying terminal / card context (Stage
   *  5.2 spec: "关闭后焦点回到原卡片"). */
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Reset state every time the palette closes/reopens.
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setSelectedIndex(0);
      const target = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (target && typeof target.focus === 'function') {
        // Defer until after React commits the close so focus lands cleanly.
        requestAnimationFrame(() => target.focus());
      }
    }
  }, [open]);

  const filtered = useMemo(() => fuzzyFilter(entries, query), [entries, query]);

  useEffect(() => {
    if (!open || query.trim()) return;
    if (!initialGroup) return;
    const idx = filtered.findIndex((entry) => entry.group === initialGroup);
    if (idx >= 0) setSelectedIndex(idx);
  }, [filtered, initialGroup, open, query]);

  // Reset selection whenever the filtered list shrinks past the cursor.
  useEffect(() => {
    if (selectedIndex >= filtered.length) setSelectedIndex(0);
  }, [filtered.length, selectedIndex]);

  // Group entries for rendering.
  const grouped = useMemo(() => {
    const map = new Map<CommandGroup, CommandEntry[]>();
    for (const e of filtered) {
      const list = map.get(e.group) ?? [];
      list.push(e);
      map.set(e.group, list);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g)! }));
  }, [filtered]);

  // Keyboard handler — registered only while open.
  useEffect(() => {
    if (!open) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) =>
          filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
        );
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const target = filtered[selectedIndex];
        if (target) {
          target.run();
          onClose();
        }
        return;
      }
    };

    window.addEventListener('keydown', handler, { capture: true });
    return () =>
      window.removeEventListener('keydown', handler, { capture: true } as EventListenerOptions);
  }, [open, filtered, selectedIndex, onClose]);

  if (!open) return null;

  // Compute a flat index for each entry so we can highlight the selected one.
  const flatIndexById = new Map<string, number>();
  filtered.forEach((e, i) => flatIndexById.set(e.id, i));

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center bg-background/40 backdrop-blur-md pt-[15vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t('palette.label', { defaultValue: 'Command palette' })}
        className="w-full max-w-xl rounded-[var(--radius)] border border-white/10 bg-background/80 backdrop-blur-2xl shadow-studio glass-reflection"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          data-testid="palette-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          placeholder={t('palette.placeholder', { defaultValue: 'Type a command…' })}
          className="w-full rounded-t-[var(--radius)] border-b border-white/5 bg-transparent px-3 py-3 text-sm outline-none placeholder:text-muted-foreground transition-all focus:bg-white/5"
        />

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5 border border-white/10 mb-4 shadow-sm">
              <Search className="h-5 w-5 text-muted-foreground/50" />
            </div>
            <div className="text-sm font-medium text-foreground/80 mb-1">
              {t('palette.emptyTitle', { defaultValue: 'No matches found' })}
            </div>
            <div className="text-xs text-muted-foreground/60 max-w-[240px]">
              {t('palette.emptyDescription', { defaultValue: 'Try a different command or search term.' })}
            </div>
          </div>
        ) : (
          <ul role="listbox" className="max-h-[50vh] overflow-y-auto p-1">
            {grouped.map(({ group, items }) => (
              <li key={group}>
                <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t(`palette.groups.${group}`, { defaultValue: group })}
                </div>
                <ul>
                  {items.map((e) => {
                    const flatIdx = flatIndexById.get(e.id) ?? -1;
                    const isSelected = flatIdx === selectedIndex;
                    return (
                      <li
                        key={e.id}
                        role="option"
                        aria-selected={isSelected}
                        className={[
                          'flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-2 text-xs transition-all duration-200',
                          isSelected 
                            ? 'bg-primary/10 text-primary shadow-[0_0_15px_rgba(var(--primary),0.05)] ring-1 ring-primary/20' 
                            : 'hover:bg-white/5',
                        ].join(' ')}
                        onMouseEnter={() => setSelectedIndex(flatIdx)}
                        onClick={() => {
                          e.run();
                          onClose();
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{e.label}</div>
                          {e.detail && (
                            <div className="truncate text-[10px] text-muted-foreground">
                              {e.detail}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
