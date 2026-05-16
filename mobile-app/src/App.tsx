import {
  Bell,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Gauge,
  Languages,
  Monitor,
  Moon,
  QrCode,
  ScanLine,
  Search,
  Settings,
  Smartphone,
  SquareTerminal,
  Sun,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type * as React from 'react';
import type {
  CardMeta,
  NotificationEntry,
  ServerMessage,
  TerminalStatus,
} from '@shared/mobile/bridge/protocol';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';
import { InputBar } from './input/InputBar';
import { MainTerminal } from './MainTerminal';
import {
  initialBridgeState,
  reduceBridgeState,
} from './bridge/messages';
import {
  PERMISSION_KEY,
  TOKEN_KEY,
  pairDevice,
  readPairingConfig,
  scrubPairingCodeFromUrl,
  storePairing,
} from './bridge/pairing';
import { fetchSnapshot, useBridgeConnection } from './bridge/useBridgeConnection';
import { appendTerminalMessage } from './terminalTranscript';
import {
  MobileThemeController,
  createFallbackThemeFromUrl,
  readMobileThemePreference,
  type MobileThemePreference,
} from './theme';
import { useI18n, type MobileLanguagePreference, type MobileI18n } from './i18n';

type TabId = 'terminal' | 'instances' | 'settings';

export function App() {
  const pairing = useMemo(() => readPairingConfig(window.location), []);
  const themeControllerRef = useRef<MobileThemeController | null>(null);
  if (!themeControllerRef.current) {
    themeControllerRef.current = new MobileThemeController(
      createFallbackThemeFromUrl(window.location.search),
      readMobileThemePreference(),
    );
  }

  const [state, dispatch] = useReducer(reduceBridgeState, initialBridgeState);
  const [token, setToken] = useState<string | null>(pairing.storedToken);
  const [permission, setPermission] = useState(pairing.permission);
  const [deviceName, setDeviceName] = useState(pairing.deviceName);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [terminalMessages, setTerminalMessages] = useState<ServerMessage[]>([]);
  const [tab, setTab] = useState<TabId>('terminal');
  const [detailOpen, setDetailOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [themePreference, setThemePreference] = useState<MobileThemePreference>(
    themeControllerRef.current.getPreference(),
  );

  const applyMessage = useCallback((message: ServerMessage) => {
    if (message.kind === 'theme') {
      // App/page tokens still follow the desktop theme. The mobile terminal
      // itself is intentionally a fixed dark surface (see MainTerminal), so the
      // xterm theme is not threaded through here anymore.
      themeControllerRef.current?.applyServerTheme(message);
    }

    if (message.kind === 'terminal_output' || message.kind === 'terminal_snapshot') {
      setTerminalMessages((current) => appendTerminalMessage(current, message));
    }

    dispatch({ type: 'server-message', message });
  }, []);

  const loadSnapshot = useCallback(async () => {
    if (!token) return;
    try {
      applyMessage(await fetchSnapshot(token));
    } catch (error) {
      dispatch({
        type: 'ws-error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [applyMessage, token]);

  const bridge = useBridgeConnection({
    token,
    onMessage: applyMessage,
    onLagged: loadSnapshot,
    onError: (message) => dispatch({ type: 'ws-error', message }),
    onResume: loadSnapshot,
  });

  const handlePair = useCallback(async () => {
    if (!pairing.otp) return;
    setPairingBusy(true);
    setPairingError(null);
    try {
      const result = await pairDevice(pairing.otp, deviceName, pairing.permission);
      storePairing(result, deviceName);
      setToken(result.deviceToken);
      setPermission(result.device.permission);
      scrubPairingCodeFromUrl();
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : String(error));
    } finally {
      setPairingBusy(false);
    }
  }, [deviceName, pairing.otp, pairing.permission]);

  useEffect(() => {
    dispatch({ type: 'ws-status', status: bridge.state });
  }, [bridge.state]);

  useEffect(() => {
    if (token) {
      void loadSnapshot();
    }
  }, [loadSnapshot, token]);

  useEffect(() => {
    if (!token && pairing.otp) {
      void handlePair();
    }
    // Auto-pair only once with the bootstrapped query config.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeCard = state.cards.find((card) => card.id === state.activeCardId) ?? null;
  const filteredCards = useMemo(
    () => filterCards(state.cards, searchQuery),
    [searchQuery, state.cards],
  );
  const canSend = permission === 'full' && Boolean(activeCard) && bridge.state === 'open';

  useEffect(() => {
    if (detailOpen && !activeCard) {
      setDetailOpen(false);
    }
  }, [activeCard, detailOpen]);

  const updateThemePreference = (preference: MobileThemePreference) => {
    themeControllerRef.current?.setPreference(preference);
    setThemePreference(preference);
  };

  const openCard = (cardId: string) => {
    dispatch({ type: 'select-card', cardId });
    setDetailOpen(true);
    setScannerOpen(false);
    void loadSnapshot();
  };

  const sendInput = (data: string) => {
    if (!activeCard || permission !== 'full') return;
    try {
      bridge.send({ kind: 'input', card_id: activeCard.id, data });
    } catch (error) {
      dispatch({
        type: 'ws-error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Only full-control devices may push xterm fit() dimensions back to the PTY.
  // Read-only / preview surfaces leave onResize undefined so local fitting
  // never issues a read-only resize command.
  const sendResize =
    permission === 'full'
      ? (cols: number, rows: number) => {
          if (!activeCard) return;
          try {
            bridge.send({ kind: 'resize', card_id: activeCard.id, cols, rows });
          } catch (error) {
            dispatch({
              type: 'ws-error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      : undefined;

  if (!token) {
    return (
      <PairingScreen
        busy={pairingBusy}
        deviceName={deviceName}
        error={pairingError}
        hasOtp={Boolean(pairing.otp)}
        onDeviceNameChange={setDeviceName}
        onPair={() => void handlePair()}
        permission={pairing.permission}
      />
    );
  }

  return (
    <div className="ios-shell">
      {scannerOpen ? (
        <ScannerScreen
          bridgeAddress={window.location.host}
          onClose={() => setScannerOpen(false)}
          permission={permission}
          wsStatus={bridge.state}
        />
      ) : detailOpen ? (
        <TerminalDetail
          activeCard={activeCard}
          canSend={canSend}
          messages={terminalMessages}
          onBack={() => setDetailOpen(false)}
          onOpenSettings={() => {
            setDetailOpen(false);
            setTab('settings');
          }}
          onResize={sendResize}
          onSend={sendInput}
          permission={permission}
          wsStatus={bridge.state}
        />
      ) : (
        <>
          {tab === 'terminal' && (
            <TerminalHome
              activeCard={activeCard}
              bridgeAddress={window.location.host}
              cards={state.cards}
              messages={terminalMessages}
              onOpenCard={openCard}
              onOpenScanner={() => setScannerOpen(true)}
              onSearchChange={setSearchQuery}
              permission={permission}
              searchQuery={searchQuery}
              wsStatus={bridge.state}
            />
          )}
          {tab === 'instances' && (
            <InstancesScreen
              activeCardId={state.activeCardId}
              cards={filteredCards}
              onOpenCard={openCard}
              onSearchChange={setSearchQuery}
              searchQuery={searchQuery}
            />
          )}
          {tab === 'settings' && (
            <SettingsScreen
              activeCard={activeCard}
              bridgeAddress={window.location.host}
              lastError={state.lastError}
              notifications={state.notifications}
              onThemePreferenceChange={updateThemePreference}
              permission={permission}
              themePreference={themePreference}
              wsStatus={bridge.state}
            />
          )}
          <TabBar activeTab={tab} onChange={setTab} />
        </>
      )}
    </div>
  );
}

function PairingScreen({
  busy,
  deviceName,
  error,
  hasOtp,
  onDeviceNameChange,
  onPair,
  permission,
}: {
  busy: boolean;
  deviceName: string;
  error: string | null;
  hasOtp: boolean;
  onDeviceNameChange: (value: string) => void;
  onPair: () => void;
  permission: string;
}) {
  const { t } = useI18n();
  return (
    <main className="pair-screen">
      <section className="pair-panel">
        <div className="pair-icon">
          <Smartphone size={28} />
        </div>
        <p className="eyebrow">{t('pair.eyebrow')}</p>
        <h1>{hasOtp ? t('pair.title.has') : t('pair.title.none')}</h1>
        {hasOtp ? (
          <>
            <label>
              {t('pair.deviceName')}
              <input value={deviceName} onChange={(event) => onDeviceNameChange(event.target.value)} />
            </label>
            <p className="readonly-strip pair-permission">
              {permission === 'full' ? t('pair.full') : t('pair.readonly')}
            </p>
            <button type="button" onClick={onPair} disabled={busy}>
              {busy ? t('pair.button.busy') : t('pair.button.idle')}
            </button>
          </>
        ) : (
          <p className="empty-copy">{t('pair.reopen')}</p>
        )}
        {error && <p className="pair-error">{error}</p>}
      </section>
    </main>
  );
}

function TerminalHome({
  activeCard,
  bridgeAddress,
  cards,
  messages,
  onOpenCard,
  onOpenScanner,
  onSearchChange,
  permission,
  searchQuery,
  wsStatus,
}: {
  activeCard: CardMeta | null;
  bridgeAddress: string;
  cards: CardMeta[];
  messages: ServerMessage[];
  onOpenCard: (cardId: string) => void;
  onOpenScanner: () => void;
  onSearchChange: (value: string) => void;
  permission: string;
  searchQuery: string;
  wsStatus: BridgeConnectionState;
}) {
  const { t } = useI18n();
  return (
    <main className="ios-screen">
      <IosHeader
        action={
          <button className="nav-icon-button" type="button" onClick={onOpenScanner} aria-label={t('home.syncQr')}>
            <QrCode size={22} />
          </button>
        }
        title="ThreadTerm"
      />
      <div className="screen-content">
        <SearchField value={searchQuery} onChange={onSearchChange} />

        <section className="ios-list-card">
          <button className="ios-list-item" type="button" onClick={onOpenScanner}>
            <span className="list-icon list-icon-blue">
              <QrCode size={18} />
            </span>
            <span className="list-main">
              <strong>{t('home.syncQr')}</strong>
              <span>{bridgeAddress}</span>
            </span>
            <ChevronRight size={18} />
          </button>
          <div className="ios-list-item">
            <span className="list-icon list-icon-gray">
              {wsStatus === 'open' ? <Wifi size={18} /> : <WifiOff size={18} />}
            </span>
            <span className="list-main">
              <strong>{t('home.connection')}</strong>
              <span>
                {cards.length} {cards.length === 1 ? t('home.session') : t('home.sessions')} ·{' '}
                {permissionLabel(permission, t)}
              </span>
            </span>
            <StatusBadge status={wsStatus} />
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading">
            <h2>{t('home.activeSession')}</h2>
            <StatusBadge status={wsStatus} />
          </div>
          {activeCard ? (
            <div
              className="session-preview"
              role="button"
              tabIndex={0}
              onClick={() => onOpenCard(activeCard.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpenCard(activeCard.id);
                }
              }}
            >
              <div className="terminal-preview-frame">
                <MainTerminal
                  activeCardId={activeCard.id}
                  messages={messages}
                  mode="preview"
                />
              </div>
              <div className="preview-footer">
                <span>
                  <strong>{activeCard.projectName || activeCard.id}</strong>
                  <small>{displayCardSummary(activeCard)}</small>
                </span>
                <span className="preview-action">{t('home.tapFocus')}</span>
              </div>
            </div>
          ) : (
            <EmptyState label={t('home.noSessions')} />
          )}
        </section>

        {cards.length > 0 && (
          <section className="section-block">
            <div className="section-heading">
              <h2>{t('home.allSessions')}</h2>
              <span>{cards.length}</span>
            </div>
            <div className="ios-list-card">
              {cards.map((card) => (
                <SessionRow
                  active={card.id === activeCard?.id}
                  card={card}
                  key={card.id}
                  muted={!isLiveStatus(card.status)}
                  onOpen={() => onOpenCard(card.id)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function InstancesScreen({
  activeCardId,
  cards,
  onOpenCard,
  onSearchChange,
  searchQuery,
}: {
  activeCardId: string | null;
  cards: CardMeta[];
  onOpenCard: (cardId: string) => void;
  onSearchChange: (value: string) => void;
  searchQuery: string;
}) {
  const { t } = useI18n();
  const activeCards = cards.filter((card) => isLiveStatus(card.status));
  const inactiveCards = cards.filter((card) => !isLiveStatus(card.status));

  return (
    <main className="ios-screen">
      <IosHeader title={t('instances.title')} />
      <div className="screen-content">
        <SearchField value={searchQuery} onChange={onSearchChange} />
        <SessionGroup
          activeCardId={activeCardId}
          cards={activeCards}
          emptyLabel={t('instances.noActive')}
          onOpenCard={onOpenCard}
          title={t('instances.active')}
        />
        <SessionGroup
          activeCardId={activeCardId}
          cards={inactiveCards}
          emptyLabel={t('instances.noOffline')}
          muted
          onOpenCard={onOpenCard}
          title={t('instances.offline')}
        />
      </div>
    </main>
  );
}

function SettingsScreen({
  activeCard,
  bridgeAddress,
  lastError,
  notifications,
  onThemePreferenceChange,
  permission,
  themePreference,
  wsStatus,
}: {
  activeCard: CardMeta | null;
  bridgeAddress: string;
  lastError: string | null;
  notifications: NotificationEntry[];
  onThemePreferenceChange: (preference: MobileThemePreference) => void;
  permission: string;
  themePreference: MobileThemePreference;
  wsStatus: BridgeConnectionState;
}) {
  const { t, preference: languagePreference, setPreference: onLanguagePreferenceChange } = useI18n();
  const appearanceLabel: Record<MobileThemePreference, string> = {
    auto: t('settings.appearance.auto'),
    dark: t('settings.appearance.dark'),
    light: t('settings.appearance.light'),
  };
  const languageLabel: Record<MobileLanguagePreference, string> = {
    auto: t('settings.language.auto'),
    zh: t('settings.language.zh'),
    en: t('settings.language.en'),
  };
  return (
    <main className="ios-screen">
      <IosHeader title={t('settings.title')} />
      <div className="screen-content">
        <section className="profile-block">
          <div className="profile-avatar">
            <Monitor size={36} />
          </div>
          <h2>{activeCard?.projectName ?? t('settings.mobileBridge')}</h2>
          <span>{permissionLabel(permission, t)} · {bridgeAddress}</span>
        </section>

        <section className="ios-list-card">
          <InfoRow icon={<Gauge size={18} />} label={t('settings.websocket')} value={wsStatus} />
          <InfoRow icon={<SquareTerminal size={18} />} label={t('settings.pty')} value={activeCard?.status ?? 'idle'} />
          <InfoRow
            icon={<Boxes size={18} />}
            label={t('settings.recentOutput')}
            value={activeCard ? `${activeCard.recentOutputBytes} bytes` : '0 bytes'}
          />
          <InfoRow icon={<Smartphone size={18} />} label={t('settings.device')} value={permissionLabel(permission, t)} />
          {lastError && <InfoRow danger icon={<WifiOff size={18} />} label={t('settings.lastError')} value={lastError} />}
        </section>

        <section className="settings-section">
          <h2>{t('settings.appearance')}</h2>
          <div className="segmented">
            {(['auto', 'dark', 'light'] as const).map((mode) => (
              <button
                className={themePreference === mode ? 'segmented-active' : ''}
                type="button"
                key={mode}
                onClick={() => onThemePreferenceChange(mode)}
              >
                {mode === 'light' ? <Sun size={15} /> : <Moon size={15} />}
                {appearanceLabel[mode]}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h2>{t('settings.language')}</h2>
          <div className="segmented">
            {(['auto', 'zh', 'en'] as const).map((lang) => (
              <button
                className={languagePreference === lang ? 'segmented-active' : ''}
                type="button"
                key={lang}
                onClick={() => onLanguagePreferenceChange(lang)}
              >
                <Languages size={15} />
                {languageLabel[lang]}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="section-heading">
            <h2>{t('settings.notifications')}</h2>
            <Bell size={16} />
          </div>
          {notifications.length === 0 ? (
            <EmptyState label={t('settings.noNotifications')} />
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
    </main>
  );
}

function TerminalDetail({
  activeCard,
  canSend,
  messages,
  onBack,
  onOpenSettings,
  onResize,
  onSend,
  permission,
  wsStatus,
}: {
  activeCard: CardMeta | null;
  canSend: boolean;
  messages: ServerMessage[];
  onBack: () => void;
  onOpenSettings: () => void;
  onResize: ((cols: number, rows: number) => void) | undefined;
  onSend: (data: string) => void;
  permission: string;
  wsStatus: BridgeConnectionState;
}) {
  const { t } = useI18n();
  return (
    <main className="terminal-detail-screen">
      <header className="terminal-nav safe-top">
        <button className="nav-text-button" type="button" onClick={onBack}>
          <ChevronLeft size={22} />
          {t('detail.back')}
        </button>
        <div className="terminal-title">
          <strong>{activeCard?.projectName ?? t('detail.terminal')}</strong>
          <span>{activeCard?.projectPath ?? wsStatus}</span>
        </div>
        <button className="nav-icon-button" type="button" onClick={onOpenSettings} aria-label="Open settings">
          <Settings size={20} />
        </button>
      </header>

      <MainTerminal
        activeCardId={activeCard?.id ?? null}
        className="terminal-detail-output"
        messages={messages}
        onResize={onResize}
      />

      {permission === 'full' ? (
        <>
          <div className="terminal-toolbar" aria-label="Terminal controls">
            <button type="button" disabled={!canSend} onClick={() => onSend('\r')}>Enter</button>
            <button type="button" disabled={!canSend} onClick={() => onSend('\x1b')}>Esc</button>
            <button type="button" disabled={!canSend} onClick={() => onSend('\x03')}>Ctrl-C</button>
          </div>
          <InputBar disabled={!canSend} onSend={onSend} />
        </>
      ) : (
        <div className="readonly-strip detail-readonly">{t('detail.readonly')}</div>
      )}
    </main>
  );
}

function ScannerScreen({
  bridgeAddress,
  onClose,
  permission,
  wsStatus,
}: {
  bridgeAddress: string;
  onClose: () => void;
  permission: string;
  wsStatus: BridgeConnectionState;
}) {
  const { t } = useI18n();
  return (
    <main className="scanner-screen">
      <header className="scanner-nav safe-top">
        <button className="nav-text-button scanner-cancel" type="button" onClick={onClose}>
          {t('scanner.cancel')}
        </button>
        <strong>{t('scanner.title')}</strong>
        <Smartphone size={22} />
      </header>
      <div className="scanner-body">
        <div className="scanner-grid" />
        <div className="scanner-frame">
          <ScanLine size={48} />
          <span />
        </div>
        <div className="scanner-caption">
          <strong>{bridgeAddress}</strong>
          <span>{statusText(wsStatus)} · {permissionLabel(permission, t)}</span>
        </div>
      </div>
    </main>
  );
}

function IosHeader({ action, title }: { action?: React.ReactNode; title: string }) {
  return (
    <header className="ios-header safe-top">
      <h1>{title}</h1>
      <div className="header-action">{action}</div>
    </header>
  );
}

function SearchField({ onChange, value }: { onChange: (value: string) => void; value: string }) {
  return (
    <label className="search-field">
      <Search size={16} />
      <input
        aria-label="Search sessions"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search sessions..."
      />
    </label>
  );
}

function SessionGroup({
  activeCardId,
  cards,
  emptyLabel,
  muted = false,
  onOpenCard,
  title,
}: {
  activeCardId: string | null;
  cards: CardMeta[];
  emptyLabel: string;
  muted?: boolean;
  onOpenCard: (cardId: string) => void;
  title: string;
}) {
  return (
    <section className="section-block">
      <div className="section-heading">
        <h2>{title}</h2>
        <span>{cards.length}</span>
      </div>
      <div className="ios-list-card">
        {cards.length === 0 ? (
          <EmptyState label={emptyLabel} />
        ) : (
          cards.map((card) => (
            <SessionRow
              active={card.id === activeCardId}
              card={card}
              key={card.id}
              muted={muted}
              onOpen={() => onOpenCard(card.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function SessionRow({
  active,
  card,
  muted,
  onOpen,
}: {
  active: boolean;
  card: CardMeta;
  muted: boolean;
  onOpen: () => void;
}) {
  return (
    <button className={`instance-row ${active ? 'instance-row-active' : ''}`} type="button" onClick={onOpen}>
      <span className={`instance-icon ${muted ? 'instance-icon-muted' : ''}`}>
        {isLiveStatus(card.status) ? <CheckCircle2 size={20} /> : <Circle size={20} />}
      </span>
      <span className="list-main">
        <strong>{card.projectName || card.id}</strong>
        <span>{displayCardSummary(card)}</span>
      </span>
      <span className="instance-meta">
        <StatusBadge status={card.status} />
        <small>{formatBytes(card.recentOutputBytes)}</small>
      </span>
    </button>
  );
}

function InfoRow({
  danger = false,
  icon,
  label,
  value,
}: {
  danger?: boolean;
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className={`ios-list-item ${danger ? 'info-row-danger' : ''}`}>
      <span className="list-icon list-icon-gray">{icon}</span>
      <span className="list-main">
        <strong>{label}</strong>
      </span>
      <span className="info-value">{value}</span>
    </div>
  );
}

function TabBar({ activeTab, onChange }: { activeTab: TabId; onChange: (tab: TabId) => void }) {
  const { t } = useI18n();
  return (
    <footer className="tab-bar safe-bottom">
      <button
        className={activeTab === 'terminal' ? 'tab-active' : ''}
        type="button"
        onClick={() => onChange('terminal')}
      >
        <SquareTerminal size={22} />
        <span>{t('tab.terminal')}</span>
      </button>
      <button
        className={activeTab === 'instances' ? 'tab-active' : ''}
        type="button"
        onClick={() => onChange('instances')}
      >
        <Boxes size={22} />
        <span>{t('tab.instances')}</span>
      </button>
      <button
        className={activeTab === 'settings' ? 'tab-active' : ''}
        type="button"
        onClick={() => onChange('settings')}
      >
        <Settings size={22} />
        <span>{t('tab.settings')}</span>
      </button>
    </footer>
  );
}

function StatusBadge({ status }: { status: BridgeConnectionState | TerminalStatus }) {
  return <span className={`status-badge status-badge-${status}`}>{statusText(status)}</span>;
}

function EmptyState({ label }: { label: string }) {
  return <p className="empty-copy empty-state">{label}</p>;
}

export function clearStoredPairing() {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(PERMISSION_KEY);
}

function filterCards(cards: CardMeta[], query: string): CardMeta[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return cards;
  return cards.filter((card) => {
    const haystack = [
      card.id,
      card.projectName,
      card.projectPath,
      card.summaryLine ?? '',
      card.lastReplyPreview,
      card.status,
    ].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

function displayCardSummary(card: CardMeta): string {
  return card.summaryLine || card.lastReplyPreview || card.projectPath || card.id;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${Math.round(value / 102.4) / 10} KB`;
}

function isLiveStatus(status: TerminalStatus): boolean {
  return status === 'running' || status === 'waiting_for_input';
}

function permissionLabel(permission: string, t: MobileI18n['t']): string {
  return permission === 'full' ? t('common.fullControl') : t('common.readonly');
}

function statusText(status: BridgeConnectionState | TerminalStatus): string {
  return status.replace(/_/g, ' ');
}
