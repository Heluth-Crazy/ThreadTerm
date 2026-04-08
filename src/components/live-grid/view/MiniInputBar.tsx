import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp } from 'lucide-react';

type MiniInputBarProps = {
  onSend: (text: string) => void;
  disabled?: boolean;
};

export default function MiniInputBar({ onSend, disabled }: MiniInputBarProps) {
  const { t } = useTranslation('common');
  const [value, setValue] = useState('');

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="flex items-center gap-1.5 border-t border-border/40 px-2 py-1.5">
      <textarea
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={t('liveGrid.inputPlaceholder')}
        className="min-h-[26px] flex-1 resize-none rounded-md border border-border/40 bg-background/60 px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-border focus:outline-none disabled:opacity-50"
      />
      <button
        type="button"
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-foreground text-background transition-opacity hover:opacity-80 disabled:opacity-30"
        aria-label="Send"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
