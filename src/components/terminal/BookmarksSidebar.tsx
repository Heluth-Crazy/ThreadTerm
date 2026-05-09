/**
 * BookmarksSidebar — flat list of bookmarked blocks with click-to-jump.
 *
 * Stage 5.3: read-only over `terminalStore.bookmarks`. Selecting an entry
 * fires `onJump({cardId, blockId})` so the host (TerminalManager) can call
 * `focusCard` + `selectBlock` and route the user to the right card.
 */
import { Star, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';

export interface BookmarksSidebarProps {
  onJump: (target: { cardId: string; blockId: string }) => void;
  /** When provided, renders a close button (X) in the panel header. */
  onClose?: () => void;
}

function CloseBtn({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button
      type="button"
      data-testid="bookmarks-close"
      onClick={onClose}
      title={label}
      aria-label={label}
      className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      <X className="h-3 w-3" />
    </button>
  );
}

export function BookmarksSidebar({ onJump, onClose }: BookmarksSidebarProps) {
  const { t } = useTranslation('terminal');
  const bookmarks = useTerminalStore((s) => s.bookmarks);
  const removeBookmark = useTerminalStore((s) => s.removeBookmark);

  const closeLabel = t('common.close', { defaultValue: 'Close' });

  if (bookmarks.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Star className="h-3 w-3" />
          {t('bookmarks.title', { defaultValue: 'Bookmarks' })}
          {onClose && <CloseBtn onClose={onClose} label={closeLabel} />}
        </div>
        <div className="flex flex-1 items-center justify-center p-3 text-center text-[11px] text-muted-foreground">
          {t('bookmarks.empty', { defaultValue: 'No bookmarks yet' })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Star className="h-3 w-3" />
        {t('bookmarks.title', { defaultValue: 'Bookmarks' })}
        {onClose && <CloseBtn onClose={onClose} label={closeLabel} />}
      </div>
      <ul className="flex-1 overflow-y-auto p-1.5">
        {bookmarks.map((b) => (
          <li
            key={b.id}
            className="group flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-xs hover:bg-accent"
            onClick={() => onJump({ cardId: b.cardId, blockId: b.blockId })}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[11px]">{b.command}</div>
              <div className="truncate text-[10px] text-muted-foreground">{b.cwd}</div>
            </div>
            <button
              type="button"
              data-testid={`bookmark-remove-${b.blockId}`}
              onClick={(e) => {
                e.stopPropagation();
                removeBookmark(b.id);
              }}
              className="opacity-0 transition group-hover:opacity-100"
              title={t('block.unbookmark', { defaultValue: 'Remove bookmark' })}
            >
              <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
