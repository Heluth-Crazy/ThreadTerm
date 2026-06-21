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
  Pencil,
  Play,
  Plus,
  QrCode,
  ScanLine,
  Search,
  Settings,
  Smartphone,
  SquareTerminal,
  Sun,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type * as React from 'react';
import type {
  CardMeta,
  ClientCommand,
  NotificationEntry,
  ServerMessage,
  TerminalStatus,
} from '@shared/mobile/bridge/protocol';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';
import { compareCardsByActivity } from '@shared/lib/cardSort';
import { ConnectionBanner } from './ConnectionBanner';
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
import { pushTerminalFeedMessage } from './terminalFeed';
import {
  MobileThemeController,
  createFallbackThemeFromUrl,
  readMobileThemePreference,
  type MobileThemePreference,
} from './theme';
import { useI18n, type MobileLanguagePreference, type MobileI18n } from './i18n';

type TabId = 'terminal' | 'instances' | 'settings';
type NewSessionInput = {
  projectPath: string;
  terminalType: string;
  command?: string;
};
type ProjectCardGroup = {
  key: string;
  projectName: string;
  projectPath: string;
  cards: CardMeta[];
};

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
  // Monotonic counter bumped ONLY when the server signals backpressure
  // (broadcast Lagged -> error/backpressure -> onLagged). A bump tells
  // MainTerminal to treat the very next terminal_snapshot as a one-shot
  // recovery reset so the dropped terminal_output segment is repainted.
  // Plain reconnects (visibility/online/pageshow -> onResume) MUST NOT bump
  // this so issue-5 (history survives a reconnect snapshot) is unchanged.
  const [recoveryNonce, setRecoveryNonce] = useState(0);
  const [tab, setTab] = useState<TabId>('terminal');
  const [detailOpen, setDetailOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
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
      // Stage 5 (audit P1-3): terminal transport bypasses React state. The
      // per-card feed buckets the chunk and notifies subscribed MainTerminal
      // instances directly, so a hot output stream no longer re-renders the
      // whole App tree per chunk.
      pushTerminalFeedMessage(message);
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

  // Backpressure recovery: arm a one-shot snapshot re-apply in MainTerminal,
  // THEN fetch the fresh snapshot. The bump is exclusive to this path (never
  // onResume) so the issue-5 reconnect guard stays intact.
  const handleLagged = useCallback(() => {
    setRecoveryNonce((nonce) => nonce + 1);
    void loadSnapshot();
  }, [loadSnapshot]);

  const bridge = useBridgeConnection({
    token,
    onMessage: applyMessage,
    onLagged: handleLagged,
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
  const canControl = permission === 'full' && bridge.state === 'open';
  const canSend = canControl && Boolean(activeCard?.ptyLive);

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

  const sendCommand = useCallback((command: ClientCommand) => {
    try {
      bridge.send(command);
    } catch (error) {
      dispatch({
        type: 'ws-error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [bridge]);

  const createRequestId = useCallback(
    (kind: string) => `${kind}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    [],
  );

  const requestActivate = useCallback(
    (cardId: string) => {
      if (!canControl) return;
      sendCommand({ kind: 'activate', request_id: createRequestId('activate'), card_id: cardId });
    },
    [canControl, createRequestId, sendCommand],
  );

  const requestClose = useCallback(
    (cardId: string) => {
      if (!canControl) return;
      sendCommand({ kind: 'close', request_id: createRequestId('close'), card_id: cardId });
    },
    [canControl, createRequestId, sendCommand],
  );

  const requestRenameCard = useCallback(
    (cardId: string, projectName: string) => {
      if (!canControl) return;
      const trimmed = projectName.trim();
      if (!trimmed) return;
      sendCommand({
        kind: 'rename_card',
        request_id: createRequestId('rename'),
        card_id: cardId,
        project_name: trimmed,
      });
    },
    [canControl, createRequestId, sendCommand],
  );

  const requestSpawn = useCallback(
    ({ command, projectPath, terminalType }: NewSessionInput) => {
      if (!canControl) return;
      const trimmedProjectPath = projectPath.trim();
      if (!trimmedProjectPath) return;
      const trimmedCommand = command?.trim();
      sendCommand({
        kind: 'spawn',
        request_id: createRequestId('spawn'),
        terminal_type: terminalType,
        project_path: trimmedProjectPath,
        ...(trimmedCommand ? { command: trimmedCommand } : {}),
      });
      setNewSessionOpen(false);
      setTab('instances');
    },
    [canControl, createRequestId, sendCommand],
  );

  const sendInput = (data: string) => {
    if (!activeCard || permission !== 'full') return;
    sendCommand({ kind: 'input', card_id: activeCard.id, data });
  };

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
          recoveryNonce={recoveryNonce}
          onBack={() => setDetailOpen(false)}
          onActivate={requestActivate}
          onCloseCard={requestClose}
          onOpenSettings={() => {
            setDetailOpen(false);
            setTab('settings');
          }}
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
              canControl={canControl}
              recoveryNonce={recoveryNonce}
              onActivateCard={requestActivate}
              onDeleteCard={requestClose}
              onOpenCard={openCard}
              onOpenScanner={() => setScannerOpen(true)}
              onRenameCard={requestRenameCard}
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
              canControl={canControl}
              newSessionOpen={newSessionOpen}
              onActivateCard={requestActivate}
              onCreateSession={requestSpawn}
              onDeleteCard={requestClose}
              onNewSessionOpenChange={setNewSessionOpen}
              onOpenCard={openCard}
              onRenameCard={requestRenameCard}
              onSearchChange={setSearchQuery}
              searchQuery={searchQuery}
              warmingUp={state.warmingUp}
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
  canControl,
  recoveryNonce,
  onActivateCard,
  onDeleteCard,
  onOpenCard,
  onOpenScanner,
  onRenameCard,
  onSearchChange,
  permission,
  searchQuery,
  wsStatus,
}: {
  activeCard: CardMeta | null;
  bridgeAddress: string;
  cards: CardMeta[];
  canControl: boolean;
  recoveryNonce: number;
  onActivateCard: (cardId: string) => void;
  onDeleteCard: (cardId: string) => void;
  onOpenCard: (cardId: string) => void;
  onOpenScanner: () => void;
  onRenameCard?: (cardId: string, projectName: string) => void;
  onSearchChange: (value: string) => void;
  permission: string;
  searchQuery: string;
  wsStatus: BridgeConnectionState;
}) {
  const { t } = useI18n();
  // Mirror InstancesScreen: the home search field filters the "All sessions"
  // list too, otherwise the field on this screen would do nothing.
  const visibleCards = useMemo(() => filterCards(cards, searchQuery), [cards, searchQuery]);
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
        <ConnectionBanner wsStatus={wsStatus} />
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
                  recoveryNonce={recoveryNonce}
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
              <span>{searchQuery.trim() ? visibleCards.length : cards.length}</span>
            </div>
            <div className="ios-list-card">
              {visibleCards.length === 0 ? (
                <p className="empty-copy">{t('home.noMatches')}</p>
              ) : (
                groupCardsByProject(visibleCards).map((group) => (
                  <ProjectSessionGroup
                    activeCardId={activeCard?.id ?? null}
                    canControl={canControl}
                    group={group}
                    key={group.key}
                    onActivateCard={onActivateCard}
                    onDeleteCard={onDeleteCard}
                    onOpenCard={onOpenCard}
                    onRenameCard={onRenameCard}
                    showHeader
                  />
                ))
              )}
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
  canControl,
  newSessionOpen,
  onActivateCard,
  onCreateSession,
  onDeleteCard,
  onNewSessionOpenChange,
  onOpenCard,
  onRenameCard,
  onSearchChange,
  searchQuery,
  warmingUp,
}: {
  activeCardId: string | null;
  cards: CardMeta[];
  canControl: boolean;
  newSessionOpen: boolean;
  onActivateCard: (cardId: string) => void;
  onCreateSession: (input: NewSessionInput) => void;
  onDeleteCard: (cardId: string) => void;
  onNewSessionOpenChange: (open: boolean) => void;
  onOpenCard: (cardId: string) => void;
  onRenameCard?: (cardId: string, projectName: string) => void;
  onSearchChange: (value: string) => void;
  searchQuery: string;
  warmingUp: boolean;
}) {
  const { t } = useI18n();
  const groups = groupCardsByProject(cards);

  return (
    <main className="ios-screen">
      <IosHeader
        action={
          <button
            className="nav-icon-button"
            type="button"
            onClick={() => onNewSessionOpenChange(!newSessionOpen)}
            aria-label={t('instances.newSession')}
            disabled={!canControl}
          >
            <Plus size={22} />
          </button>
        }
        title={t('instances.title')}
      />
      <div className="screen-content">
        <SearchField value={searchQuery} onChange={onSearchChange} />
        {newSessionOpen && (
          <NewSessionForm
            disabled={!canControl}
            onCancel={() => onNewSessionOpenChange(false)}
            onCreate={onCreateSession}
          />
        )}
        {warmingUp ? (
          <EmptyState label={t('instances.warmingUp')} />
        ) : groups.length === 0 ? (
          <EmptyState label={t('instances.empty')} />
        ) : (
          groups.map((group) => (
            <section className="section-block" key={group.key}>
              <div className="section-heading project-heading">
                <h2>{group.projectName}</h2>
                <span>{group.cards.length}</span>
              </div>
              <div className="ios-list-card">
                <ProjectSessionGroup
                  activeCardId={activeCardId}
                  canControl={canControl}
                  group={group}
                  onActivateCard={onActivateCard}
                  onDeleteCard={onDeleteCard}
                  onOpenCard={onOpenCard}
                  onRenameCard={onRenameCard}
                />
              </div>
            </section>
          ))
        )}
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
          <InfoRow icon={<SquareTerminal size={18} />} label={t('settings.pty')} value={activeCard ? displayRuntimeStatus(activeCard) : 'idle'} />
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
  recoveryNonce,
  onActivate,
  onBack,
  onCloseCard,
  onOpenSettings,
  onSend,
  permission,
  wsStatus,
}: {
  activeCard: CardMeta | null;
  canSend: boolean;
  recoveryNonce: number;
  onActivate: (cardId: string) => void;
  onBack: () => void;
  onCloseCard: (cardId: string) => void;
  onOpenSettings: () => void;
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
        <div className="terminal-nav-actions">
          <button className="nav-icon-button" type="button" onClick={onOpenSettings} aria-label="Open settings">
            <Settings size={20} />
          </button>
          <button
            className="nav-icon-button"
            type="button"
            onClick={() => activeCard && onCloseCard(activeCard.id)}
            aria-label={t('instances.delete')}
            disabled={!activeCard || permission !== 'full'}
          >
            <Trash2 size={19} />
          </button>
        </div>
      </header>

      <ConnectionBanner wsStatus={wsStatus} />

      <MainTerminal
        activeCardId={activeCard?.id ?? null}
        className="terminal-detail-output"
        recoveryNonce={recoveryNonce}
      />

      {permission === 'full' ? (
        <>
          {activeCard && !activeCard.ptyLive && activeCard.attachable && (
            <div className="resume-strip">
              <span>{t('detail.notLive')}</span>
              <button type="button" onClick={() => onActivate(activeCard.id)}>
                <Play size={15} />
                {t('instances.activate')}
              </button>
            </div>
          )}
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
  const { t } = useI18n();
  return (
    <label className="search-field">
      <Search size={16} />
      <input
        aria-label={t('home.searchLabel')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('home.searchPlaceholder')}
      />
    </label>
  );
}

function NewSessionForm({
  disabled,
  onCancel,
  onCreate,
}: {
  disabled: boolean;
  onCancel: () => void;
  onCreate: (input: NewSessionInput) => void;
}) {
  const { t } = useI18n();
  const [projectPath, setProjectPath] = useState('');
  const [terminalType, setTerminalType] = useState('shell');
  const [command, setCommand] = useState('');
  const canCreate = !disabled && projectPath.trim().length > 0;

  return (
    <section className="new-session-panel">
      <div className="section-heading">
        <h2>{t('instances.newSession')}</h2>
      </div>
      <label>
        <span>{t('instances.projectPath')}</span>
        <input
          value={projectPath}
          onChange={(event) => setProjectPath(event.target.value)}
          placeholder="/Users/me/project"
        />
      </label>
      <label>
        <span>{t('instances.terminalType')}</span>
        <select value={terminalType} onChange={(event) => setTerminalType(event.target.value)}>
          {['shell', 'claude', 'codex', 'gemini', 'npm', 'yarn', 'pnpm', 'docker', 'python', 'node', 'custom'].map(
            (type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ),
          )}
        </select>
      </label>
      <label>
        <span>{t('instances.command')}</span>
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="optional" />
      </label>
      <div className="new-session-actions">
        <button type="button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          className="new-session-primary"
          type="button"
          disabled={!canCreate}
          onClick={() => onCreate({ projectPath, terminalType, command })}
        >
          {t('instances.create')}
        </button>
      </div>
    </section>
  );
}

function ProjectSessionGroup({
  activeCardId,
  canControl,
  group,
  onActivateCard,
  onDeleteCard,
  onOpenCard,
  onRenameCard,
  showHeader = false,
}: {
  activeCardId: string | null;
  canControl: boolean;
  group: ProjectCardGroup;
  onActivateCard: (cardId: string) => void;
  onDeleteCard: (cardId: string) => void;
  onOpenCard: (cardId: string) => void;
  onRenameCard?: (cardId: string, projectName: string) => void;
  showHeader?: boolean;
}) {
  return (
    <>
      {showHeader && (
        <div className="project-list-header">
          <strong>{group.projectName}</strong>
          <span>{group.cards.length}</span>
        </div>
      )}
      {group.cards.map((card) => (
        <SessionRow
          active={card.id === activeCardId}
          canControl={canControl}
          card={card}
          key={card.id}
          muted={!isCardLive(card)}
          onActivate={() => onActivateCard(card.id)}
          onDelete={() => onDeleteCard(card.id)}
          onOpen={() => onOpenCard(card.id)}
          onRename={onRenameCard ? (name: string) => onRenameCard(card.id, name) : undefined}
        />
      ))}
    </>
  );
}

function SessionRow({
  active,
  canControl,
  card,
  muted,
  onActivate,
  onDelete,
  onOpen,
  onRename,
}: {
  active: boolean;
  canControl: boolean;
  card: CardMeta;
  muted: boolean;
  onActivate: () => void;
  onDelete: () => void;
  onOpen: () => void;
  onRename?: (name: string) => void;
}) {
  const { t } = useI18n();
  const showActivate = canControl && Boolean(card.attachable) && !isCardLive(card);
  const handleRename = () => {
    if (!onRename) return;
    const nextName = window.prompt(t('instances.renamePrompt'), displayCardTitle(card));
    if (nextName !== null) {
      onRename(nextName);
    }
  };

  return (
    <div className={`instance-row ${active ? 'instance-row-active' : ''}`}>
      <button className="instance-row-main" type="button" onClick={onOpen}>
        <span className={`instance-icon ${muted ? 'instance-icon-muted' : ''}`}>
          {isCardLive(card) ? <CheckCircle2 size={20} /> : <Circle size={20} />}
        </span>
        <span className="list-main">
          <strong>{displayCardTitle(card)}</strong>
          <span>{displayCardSummary(card)}</span>
        </span>
        <span className="instance-meta">
          <StatusBadge status={displayRuntimeStatus(card)} />
          <small>{formatBytes(card.recentOutputBytes)}</small>
        </span>
      </button>
      {canControl && (
        <span className="instance-actions">
          {showActivate && (
            <button
              className="instance-action-button"
              type="button"
              onClick={onActivate}
              aria-label={t('instances.activate')}
              title={t('instances.activate')}
            >
              <Play size={16} />
            </button>
          )}
          {onRename && (
            <button
              className="instance-action-button"
              type="button"
              onClick={handleRename}
              aria-label={t('instances.rename')}
              title={t('instances.rename')}
            >
              <Pencil size={16} />
            </button>
          )}
          <button
            className="instance-action-button danger"
            type="button"
            onClick={onDelete}
            aria-label={t('instances.delete')}
            title={t('instances.delete')}
          >
            <Trash2 size={16} />
          </button>
        </span>
      )}
    </div>
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
      card.worktreePath ?? '',
      card.terminalType ?? '',
      card.command ?? '',
      card.summaryLine ?? '',
      card.lastReplyPreview,
      card.status,
    ].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

function groupCardsByProject(cards: CardMeta[]): ProjectCardGroup[] {
  const groups = new Map<string, ProjectCardGroup>();
  for (const card of cards) {
    const key = card.projectPath || card.worktreePath || 'unknown';
    const existing = groups.get(key);
    if (existing) {
      existing.cards.push(card);
      continue;
    }
    groups.set(key, {
      key,
      projectName: card.projectName || pathLeaf(key),
      projectPath: key,
      cards: [card],
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      cards: [...group.cards].sort(sortCardsForMobile),
    }))
    .sort((a, b) => {
      const latestA = a.cards[0]?.lastActivity ?? 0;
      const latestB = b.cards[0]?.lastActivity ?? 0;
      if (latestA !== latestB) return latestB - latestA;
      return a.projectName.localeCompare(b.projectName);
    });
}

function sortCardsForMobile(a: CardMeta, b: CardMeta): number {
  // Reuse the shared "activity first" comparator (live > unread > recency) so
  // mobile and desktop CardGrid stay in lockstep. Mobile liveness keeps its
  // own ptyState fallback, so resolve an explicit ptyLive boolean and let the
  // shared comparator honour it.
  return compareCardsByActivity(
    { ptyLive: isCardLive(a), unread: a.unread, lastActivity: a.lastActivity, createdAt: a.createdAt },
    { ptyLive: isCardLive(b), unread: b.unread, lastActivity: b.lastActivity, createdAt: b.createdAt },
  );
}

function pathLeaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || 'Unknown project';
}

function displayCardTitle(card: CardMeta): string {
  const type = card.terminalType ? ` · ${card.terminalType}` : '';
  return `${card.projectName || card.id}${type}`;
}

function displayCardSummary(card: CardMeta): string {
  return card.summaryLine || card.lastReplyPreview || card.command || card.projectPath || card.id;
}

function displayRuntimeStatus(card: CardMeta): TerminalStatus {
  return card.ptyLive === false ? 'idle' : card.ptyState ?? card.status;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${Math.round(value / 102.4) / 10} KB`;
}

function isCardLive(card: CardMeta): boolean {
  if (typeof card.ptyLive === 'boolean') return card.ptyLive;
  return isLiveStatus(card.ptyState ?? card.status);
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
