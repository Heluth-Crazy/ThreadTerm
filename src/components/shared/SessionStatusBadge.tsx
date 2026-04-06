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

  if (status === 'processing') {
    return (
      <span className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium',
        'bg-blue-500/10 text-blue-400',
        className
      )}>
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
        {!compact && t('sessionStatus.processing')}
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
        {!compact && t('sessionStatus.completed')}
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
        {!compact && label}
      </span>
    );
  }

  return null;
}
