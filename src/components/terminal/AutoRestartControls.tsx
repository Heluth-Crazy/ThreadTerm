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
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        title={enabled ? t('autoRestart.disable') : t('autoRestart.enable')}
        aria-pressed={enabled}
        onClick={handleToggle}
        className={[
          'rounded p-1',
          enabled
            ? 'text-emerald-600 hover:bg-emerald-500/10'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        ].join(' ')}
      >
        <RefreshCw className="h-3 w-3" />
      </button>
      {enabled && (
        <select
          value={maxRetries}
          aria-label={t('autoRestart.maxRetries')}
          title={t('autoRestart.maxRetries')}
          onClick={stopClick}
          onMouseDown={stopClick}
          onChange={handleChange}
          className="h-5 rounded border border-border bg-background px-1 text-[10px] text-foreground"
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
