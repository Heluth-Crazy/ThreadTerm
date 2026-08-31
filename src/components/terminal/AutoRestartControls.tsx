import type { ChangeEvent, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

interface AutoRestartControlsProps {
  enabled: boolean;
  maxRetries: number;
  onToggle: () => void;
  onMaxRetriesChange: (value: number) => void;
}

const RETRY_OPTIONS = [1, 2, 3, 5, 10];

const stopClick = (event: MouseEvent<HTMLElement>) => {
  event.stopPropagation();
};

export function AutoRestartControls({
  enabled,
  maxRetries,
  onToggle,
  onMaxRetriesChange,
}: AutoRestartControlsProps) {
  const { t } = useTranslation('terminal');

  const handleToggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onToggle();
  };

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    event.stopPropagation();
    onMaxRetriesChange(Number(event.target.value));
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        title={enabled ? t('autoRestart.disable') : t('autoRestart.enable')}
        aria-pressed={enabled}
        onClick={handleToggle}
        className={[
          'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          enabled
            ? 'text-success hover:bg-success/10'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        ].join(' ')}
      >
        <RefreshCw className="h-3.5 w-3.5 shrink-0" />
      </button>
      {enabled && (
        // Global `select` CSS paints a chevron 13–18px from the right.
        // Keep width and pr-7 so a 1–2 digit value is not crushed under it.
        <select
          value={maxRetries}
          aria-label={t('autoRestart.maxRetries')}
          title={t('autoRestart.maxRetries')}
          onClick={stopClick}
          onMouseDown={stopClick}
          onChange={handleChange}
          className="h-7 w-14 shrink-0 rounded-md border border-border bg-background pl-1.5 pr-7 text-[11px] leading-none tabular-nums text-foreground"
        >
          {RETRY_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
