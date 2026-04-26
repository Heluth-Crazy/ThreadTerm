import { useTranslation } from 'react-i18next';
import type { ChangeEvent, MouseEvent } from 'react';
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

  const stop = (event: MouseEvent<HTMLSelectElement>) => {
    event.stopPropagation();
  };

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    event.stopPropagation();
    const next = event.currentTarget.value as TerminalAiIntent | '';
    updateCardAiIntent(cardId, next || null);
  };

  return (
    <select
      aria-label={t('aiIntent.label')}
      title={t('aiIntent.label')}
      value={value ?? ''}
      onClick={stop}
      onMouseDown={stop}
      onChange={handleChange}
      className={[
        'rounded-md border border-border bg-background text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus:ring-2 focus:ring-ring/40',
        compact
          ? 'max-w-[90px] px-1.5 py-0.5 text-[10px]'
          : 'max-w-[120px] px-2 py-1 text-[11px]',
      ].join(' ')}
    >
      <option value="">{t('aiIntent.none')}</option>
      {AI_INTENTS.map((intent) => (
        <option key={intent} value={intent}>
          {t(`aiIntent.${intent}`)}
        </option>
      ))}
    </select>
  );
}
