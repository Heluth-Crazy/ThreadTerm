import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import { useSessionStatusStore } from '../../stores/sessionStatusStore';

interface SessionStatusBadgeProps {
  sessionId: string;
  className?: string;
  /** compact=true 时只显示图标/点，不显示文字 */
  compact?: boolean;
}

export function SessionStatusBadge({ sessionId, className, compact = false }: SessionStatusBadgeProps) {
  const { t } = useTranslation('common');
  const entry = useSessionStatusStore((state) => state.statuses[sessionId]);

  if (!entry || entry.status === 'idle') return null;

  const { status, attentionReason } = entry;

  if (compact) {
    if (status === 'processing') {
      return (
        <span className={cn(
          'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none',
          'bg-blue-500/15 text-blue-400 border border-blue-500/20',
          className
        )}>
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
          {t('sessionStatus.processing')}
        </span>
      );
    }
    if (status === 'completed') {
      return (
        <span className={cn(
          'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none',
          'bg-green-500/15 text-green-400 border border-green-500/20',
          className
        )}>
          <span className="h-1.5 w-1.5 rounded-full bg-green-400 shrink-0" />
          {t('sessionStatus.completed')}
        </span>
      );
    }
    if (status === 'needs_attention') {
      return (
        <span className={cn(
          'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none',
          'bg-red-500/15 text-red-400 border border-red-500/20 animate-pulse',
          className
        )}>
          <span className="h-1.5 w-1.5 rounded-full bg-red-400 shrink-0" />
          {t('sessionStatus.needs_attention')}
        </span>
      );
    }
    return null;
  }

  if (status === 'processing') {
    return (
      <span className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium',
        'bg-blue-500/10 text-blue-400',
        className
      )}>
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
        {t('sessionStatus.processing')}
      </span>
    );
  }

  if (status === 'completed') {
    return (
      <span className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium',
        'bg-green-500/10 text-green-400',
        className
      )}>
        <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
        {t('sessionStatus.completed')}
      </span>
    );
  }

  if (status === 'needs_attention') {
    const label = attentionReason === 'permission'
      ? t('sessionStatus.needs_attention_permission')
      : attentionReason === 'aborted'
        ? t('sessionStatus.needs_attention_aborted')
        : t('sessionStatus.needs_attention_error');

    return (
      <span className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium',
        'bg-red-500/10 text-red-400',
        className
      )}>
        <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
        {label}
      </span>
    );
  }

  return null;
}
