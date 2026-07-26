import { Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderSessionLaunchStatus } from './useValidatedProviderSessionLaunch';

interface ProviderSessionLaunchPlaceholderProps {
  status: ProviderSessionLaunchStatus;
  onRetry: () => void;
}

export function ProviderSessionLaunchPlaceholder({
  status,
  onRetry,
}: ProviderSessionLaunchPlaceholderProps) {
  const { t } = useTranslation('terminal');
  const checking = status === 'checking' || status === 'ready';

  return (
    <div
      data-testid="provider-session-validation"
      className="flex h-full w-full items-center justify-center p-4 text-center text-xs text-muted-foreground"
      aria-busy={checking}
      aria-live="polite"
    >
      <div className="flex max-w-md flex-col items-center gap-2">
        {checking ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t('aiSession.resolvingHistory')}</span>
          </>
        ) : (
          <>
            <span>
              {t(
                status === 'unavailable'
                  ? 'aiSession.historyUnavailable'
                  : 'aiSession.historyResolutionFailed',
              )}
            </span>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
            >
              <RotateCcw className="h-3 w-3" />
              {t('sessionRecovery.retry')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
