import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentSessionCatalogProgress } from '../../types/agentSession';

export interface AgentSessionCatalogProgressViewProps {
  progress: AgentSessionCatalogProgress | null;
  compact?: boolean;
}

export function AgentSessionCatalogProgressView({
  progress,
  compact = false,
}: AgentSessionCatalogProgressViewProps) {
  const { t } = useTranslation('terminal');
  if (!progress) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground" role="status">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{t('sessionRecovery.scanStarting')}</span>
      </div>
    );
  }

  const hasTotal = progress.total !== null && progress.total !== undefined;
  const total = progress.total ?? 0;
  const percent = hasTotal
    ? total === 0
      ? 100
      : Math.min(100, Math.floor((progress.completed / total) * 100))
    : null;

  return (
    <div
      className={`space-y-1.5 px-3 text-[11px] text-muted-foreground ${compact ? 'py-1.5' : 'py-2'}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span className="min-w-0 flex-1 truncate">
          {t(`sessionRecovery.scanPhase.${progress.phase}`)}
        </span>
        {hasTotal ? (
          <span className="tabular-nums">
            {progress.completed} / {total} · {percent}%
          </span>
        ) : null}
        <span className="tabular-nums">
          {t('sessionRecovery.scanElapsed', {
            seconds: Math.floor(progress.elapsedMs / 1000),
          })}
        </span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={hasTotal ? 0 : undefined}
        aria-valuemax={hasTotal ? 100 : undefined}
        aria-valuenow={percent ?? undefined}
        aria-label={t(`sessionRecovery.scanPhase.${progress.phase}`)}
      >
        <div
          className={[
            'h-full rounded-full bg-primary transition-[width] duration-150',
            hasTotal ? '' : 'w-1/3 animate-pulse',
          ].join(' ')}
          style={hasTotal ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  );
}
