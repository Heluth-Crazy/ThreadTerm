/**
 * BlockSearchPanel — Cmd/Ctrl+F modal that searches across every card's
 * blocks. Reads `cards`/`blocks` straight from `terminalStore` so it
 * always sees the latest snapshot.
 *
 * Spec (Stage 5.1):
 *   • Scope = command + cwd + project (output indexing left to a future
 *     iteration; the matcher is structured to accept it).
 *   • No persisted query: closing the panel resets state.
 *   • >5000 blocks goes through a Web Worker (handled by useBlockSearch).
 *   • Click a row → onJump({cardId, blockId}); the host wires this to
 *     focusCard + selectBlock.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, Search } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useBlockSearch } from './useBlockSearch';

export interface BlockSearchPanelProps {
  open: boolean;
  onClose: () => void;
  onJump: (target: { cardId: string; blockId: string }) => void;
}

export function BlockSearchPanel({ open, onClose, onJump }: BlockSearchPanelProps) {
  const { t } = useTranslation('terminal');
  const cards = useTerminalStore((s) => s.cards);
  const blocks = useTerminalStore((s) => s.blocks);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  /** Element that held focus before the panel opened — restored on close
   *  (Stage 5.1 parity with CommandPalette). */
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Reset query whenever the panel closes — Stage 5 spec: no persistence.
  // Restore focus to the previously focused element on close.
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      const target = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (target && typeof target.focus === 'function') {
        requestAnimationFrame(() => target.focus());
      }
    }
  }, [open]);

  const { matches, loading } = useBlockSearch({ cards, blocks, query });

  // Esc closes — capture phase to win over xterm when the focused
  // terminal is mounted underneath.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () =>
      window.removeEventListener('keydown', handler, { capture: true } as EventListenerOptions);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center bg-background/40 backdrop-blur-md pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t('search.label', { defaultValue: 'Search blocks' })}
        className="w-full max-w-2xl rounded-[var(--radius)] border border-white/10 bg-background/80 backdrop-blur-2xl shadow-[0_32px_64px_-12px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            data-testid="block-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search.placeholder', {
              defaultValue: 'Search across all blocks (commands, paths, projects)…',
            })}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground transition-all focus:bg-white/5"
          />
          {loading && (
            <span className="text-[10px] text-muted-foreground">
              {t('search.loading', { defaultValue: 'Searching…' })}
            </span>
          )}
        </div>

        {!query.trim() ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            {t('search.placeholderEmpty', {
              defaultValue: 'Type to search across all blocks',
            })}
          </div>
        ) : matches.length === 0 && !loading ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            {t('search.empty', { defaultValue: 'No matches' })}
          </div>
        ) : (
          <ul role="listbox" className="max-h-[55vh] overflow-y-auto p-1">
            {matches.map(({ block, card, field, matchedLine }) => (
              <li
                key={block.id}
                role="option"
                className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-xs hover:bg-accent"
                onClick={() => onJump({ cardId: card.id, blockId: block.id })}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11px] font-medium text-primary/90">{block.command}</div>
                  {matchedLine && (
                    <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/80 leading-relaxed">
                      ↳ {matchedLine}
                    </div>
                  )}
                  <div className="mt-1.5 flex items-center gap-2 truncate text-[10px] text-muted-foreground/70">
                    <div className="flex items-center gap-1">
                      <Folder className="h-3 w-3 shrink-0" />
                      <span className="truncate">{card.projectName}</span>
                    </div>
                    <span>·</span>
                    <span className="truncate font-mono text-[9px]">{block.cwd}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      <span className="rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-primary">
                        {t(`search.field.${field}`, { defaultValue: field })}
                      </span>
                      {/* Task 4 — start-time hint (HH:MM). startedAt is
                          guaranteed > 0 by the OSC capture; we still hide
                          when the value is unset to be safe. */}
                      {block.startedAt > 0 && (
                        <span className="tabular-nums text-muted-foreground/70">
                          {new Date(block.startedAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
