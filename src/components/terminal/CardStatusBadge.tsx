import { useTranslation } from 'react-i18next';
import type { TerminalStatus } from '../../types/terminal';
import { getStatusMeta } from './statusMeta';

export interface CardStatusBadgeProps {
  status: TerminalStatus;
  size?: 'normal' | 'compact';
}

export function CardStatusBadge({ status, size = 'normal' }: CardStatusBadgeProps) {
  const { t } = useTranslation('terminal');
  const statusInfo = getStatusMeta(status);
  const StatusIcon = statusInfo.Icon;

  if (size === 'compact') {
    // Icon-only variant used by the compact card (in the switcher).
    return (
      <StatusIcon
        className={`ml-auto h-3 w-3 ${statusInfo.tone} ${
          statusInfo.animate ? 'animate-spin' : ''
        }`}
      />
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusInfo.chip}`}
    >
      <StatusIcon className={`h-2.5 w-2.5 ${statusInfo.animate ? 'animate-spin' : ''}`} />
      {t(`status.${status}`, statusInfo.label)}
    </span>
  );
}
