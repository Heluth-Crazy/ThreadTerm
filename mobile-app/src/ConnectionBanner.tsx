import { Loader2, WifiOff } from 'lucide-react';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';
import { useI18n } from './i18n';

interface ConnectionBannerProps {
  wsStatus: BridgeConnectionState;
}

/**
 * Thin status strip shown on the Home and Terminal Detail screens while the
 * bridge WebSocket is not healthy. It renders nothing when the connection is
 * open or idle so a stable session never carries a banner.
 *
 *   connecting | reconnecting → "Reconnecting…" (spinner)
 *   closed | error            → "Connection lost" (offline icon)
 *   revoked                   → explicit re-pair guidance
 *   open | idle               → null
 */
export function ConnectionBanner({ wsStatus }: ConnectionBannerProps) {
  const { t } = useI18n();

  if (wsStatus === 'connecting' || wsStatus === 'reconnecting') {
    return (
      <div className="connection-banner connection-banner-reconnecting" role="status">
        <Loader2 size={14} className="connection-banner-spin" aria-hidden="true" />
        <span>{t('banner.reconnecting')}</span>
      </div>
    );
  }

  if (wsStatus === 'revoked') {
    return (
      <div className="connection-banner connection-banner-offline" role="status">
        <WifiOff size={14} aria-hidden="true" />
        <span>{t('banner.revoked')}</span>
      </div>
    );
  }

  if (wsStatus === 'closed' || wsStatus === 'error') {
    return (
      <div className="connection-banner connection-banner-offline" role="status">
        <WifiOff size={14} aria-hidden="true" />
        <span>{t('banner.offline')}</span>
      </div>
    );
  }

  return null;
}
