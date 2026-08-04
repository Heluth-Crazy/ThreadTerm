import { useTranslation } from 'react-i18next';

interface ConversationWindowControlsProps {
  startIndex: number;
  endIndex: number;
  totalCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
  onOlder: () => void;
  onNewer: () => void;
  onLatest: () => void;
}

export function ConversationWindowControls({
  startIndex,
  endIndex,
  totalCount,
  hasOlder,
  hasNewer,
  onOlder,
  onNewer,
  onLatest,
}: ConversationWindowControlsProps) {
  const { t } = useTranslation('terminal');
  if (!hasOlder && !hasNewer) return null;
  return (
    <div
      data-testid="conversation-window-controls"
      className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-[11px] text-muted-foreground"
    >
      <span>
        {t('chatWindow.range', {
          defaultValue: 'Showing {{start}}–{{end}} of {{total}}',
          start: totalCount === 0 ? 0 : startIndex + 1,
          end: endIndex,
          total: totalCount,
        })}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {hasOlder && (
          <button
            type="button"
            data-testid="conversation-window-older"
            onClick={onOlder}
            className="rounded border border-border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
          >
            {t('chatWindow.older', { defaultValue: 'Earlier' })}
          </button>
        )}
        {hasNewer && (
          <>
            <button
              type="button"
              data-testid="conversation-window-newer"
              onClick={onNewer}
              className="rounded border border-border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
            >
              {t('chatWindow.newer', { defaultValue: 'Newer' })}
            </button>
            <button
              type="button"
              data-testid="conversation-window-latest"
              onClick={onLatest}
              className="rounded border border-border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
            >
              {t('chatWindow.latest', { defaultValue: 'Latest' })}
            </button>
          </>
        )}
      </span>
    </div>
  );
}
