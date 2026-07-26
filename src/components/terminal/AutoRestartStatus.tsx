import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import type { TerminalCard } from '../../types/terminal';
import {
  getPendingAutoRestart,
  normalizeAutoRestartConfig,
} from '../../lib/autoRestart';

interface AutoRestartStatusProps {
  card: TerminalCard;
  /** No visual effect — both call sites render the same pill. Kept so callers type-check. */
  compact?: boolean;
}

function formatDelay(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `${seconds}s`;
}

export function AutoRestartStatus({ card }: AutoRestartStatusProps) {
  const { t } = useTranslation('terminal');
  const config = normalizeAutoRestartConfig(card.autoRestart);
  if (!config.enabled && config.history.length === 0 && !config.limitReachedAt) return null;

  const pending = getPendingAutoRestart(config);
  const latest = config.history[config.history.length - 1] ?? null;
  const title = config.history
    .slice(-4)
    .map((entry) =>
      t('autoRestart.historyLine', {
        attempt: entry.attempt,
        max: config.maxRetries,
        status: t(`autoRestart.status.${entry.status}`),
      }),
    )
    .join('\n');

  let label = t('autoRestart.enabledShort');
  if (pending) {
    label = t('autoRestart.pendingShort', {
      attempt: pending.attempt,
      max: config.maxRetries,
      delay: formatDelay(Math.max(0, pending.runAt - Date.now())),
    });
  } else if (config.limitReachedAt) {
    label = t('autoRestart.limitShort', { max: config.maxRetries });
  } else if (latest) {
    label = t('autoRestart.lastShort', {
      attempt: latest.attempt,
      max: config.maxRetries,
    });
  }

  return (
    <span
      title={title || t('autoRestart.enabled')}
      className={[
        'inline-flex min-w-0 items-center gap-1 rounded-full border border-border bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground',
        pending ? 'text-warning' : config.limitReachedAt ? 'text-destructive' : '',
      ].join(' ')}
    >
      <RefreshCw className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}
