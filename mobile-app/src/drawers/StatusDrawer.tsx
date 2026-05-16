import { Gauge, Moon, Sun, X } from 'lucide-react';
import type { CardMeta, NotificationEntry } from '@shared/mobile/bridge/protocol';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';
import type { MobileThemePreference } from '../theme';

interface StatusDrawerProps {
  open: boolean;
  activeCard: CardMeta | null;
  wsStatus: BridgeConnectionState;
  permission: string;
  notifications: NotificationEntry[];
  themePreference: MobileThemePreference;
  bridgeAddress: string;
  onThemePreferenceChange: (preference: MobileThemePreference) => void;
  onClose: () => void;
}

export function StatusDrawer({
  open,
  activeCard,
  wsStatus,
  permission,
  notifications,
  themePreference,
  bridgeAddress,
  onThemePreferenceChange,
  onClose,
}: StatusDrawerProps) {
  return (
    <aside className={`drawer drawer-right ${open ? 'drawer-open' : ''}`} aria-hidden={!open}>
      <div className="drawer-header">
        <div>
          <p className="drawer-kicker">Status</p>
          <h2>{activeCard?.projectName ?? 'Mobile bridge'}</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close status">
          <X size={18} />
        </button>
      </div>

      <div className="status-sections">
        <section className="status-panel">
          <div className="status-title">
            <Gauge size={16} />
            Connection
          </div>
          <dl>
            <div>
              <dt>WebSocket</dt>
              <dd>{wsStatus}</dd>
            </div>
            <div>
              <dt>PTY</dt>
              <dd>{activeCard?.status ?? 'idle'}</dd>
            </div>
            <div>
              <dt>Recent output</dt>
              <dd>{activeCard ? `${activeCard.recentOutputBytes} bytes` : '0 bytes'}</dd>
            </div>
            <div>
              <dt>Bridge</dt>
              <dd>{bridgeAddress}</dd>
            </div>
            <div>
              <dt>Device</dt>
              <dd>{permission}</dd>
            </div>
          </dl>
        </section>

        <section className="status-panel">
          <div className="status-title">
            {themePreference === 'light' ? <Sun size={16} /> : <Moon size={16} />}
            Theme
          </div>
          <div className="segmented">
            {(['auto', 'dark', 'light'] as const).map((mode) => (
              <button
                className={themePreference === mode ? 'segmented-active' : ''}
                type="button"
                key={mode}
                onClick={() => onThemePreferenceChange(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </section>

        <section className="status-panel">
          <div className="status-title">Attention</div>
          {notifications.length === 0 ? (
            <p className="empty-copy">No active notifications.</p>
          ) : (
            <ul className="attention-list">
              {notifications.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.kind}</strong>
                  <span>{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
