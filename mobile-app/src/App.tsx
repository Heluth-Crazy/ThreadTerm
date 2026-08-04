import {
  Activity,
  Archive,
  Bell,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  ClipboardCopy,
  Gauge,
  Info,
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
  ShieldCheck,
  Smartphone,
  SquareTerminal,
  Sun,
  Trash2,
  Wrench,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type * as React from 'react';
import type { ITheme } from '@xterm/xterm';
import type {
  CardMeta,
  ClientCommand,
  MobileWorkbenchProjection,
  NotificationEntry,
  ServerMessage,
  TerminalStatus,
} from '@shared/mobile/bridge/protocol';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';
import { compareCardsByActivity } from '@shared/lib/cardSort';
import {
  normalizeComparablePath,
  pathBasename,
  worktreeDisplayLabel,
} from '@shared/lib/worktreePaths';
import { ConnectionBanner } from './ConnectionBanner';
import { InputBar } from './input/InputBar';
import { MainTerminal } from './MainTerminal';
import {
  initialBridgeState,
  reduceBridgeState,
} from './bridge/messages';
import {
  clearPairingStorage,
  pairDevice,
  readPairingConfig,
  scrubPairingCodeFromUrl,
  storePairing,
} from './bridge/pairing';
import { fetchSnapshot, useBridgeConnection } from './bridge/useBridgeConnection';
import {
  disposeTerminalFeed,
  observeTerminalFeedSnapshot,
  pushTerminalFeedMessage,
  retainTerminalFeedCards,
} from './terminalFeed';
import {
  MobileThemeController,
  createFallbackThemeFromUrl,
  readMobileThemePreference,
  type MobileThemePreference,
} from './theme';
import { useI18n, type MobileLanguagePreference, type MobileI18n } from './i18n';
import {
  AttentionDetailScreen,
  DetailScaffold,
  ExecutionGroupDetailScreen,
  NotificationsScreen,
  RulesScreen,
  WorkbenchScreen,
} from './workbench/MobileWorkbenchScreens';
import {
  TerminalCloseSheet,
  WorkspaceShell,
  syntheticTabsFromCards,
  type DirtyCloseChoice,
  type TerminalCloseChoice,
  type TerminalClosePhase,
  type TerminalCloseResult,
} from './workspace';
import type { WorkspaceTab } from '@shared/lib/workspace/types';
import { LEGACY_CAPABILITIES, type BridgeCapability } from './bridge/types';

type TabId = 'workbench' | 'workspaces' | 'settings';
type SettingsSection =
  | 'connection'
  | 'permissions'
  | 'notifications'
  | 'appearance'
  | 'language'
  | 'diagnostics'
  | 'about';
type MobileRoute =
  | { name: 'attention'; id: string }
  | { name: 'execution-group'; id: string }
  | { name: 'notifications' }
  | { name: 'rules' }
  | { name: 'terminal'; cardId: string }
  | { name: 'workspace'; workspaceKey: string }
  | { name: 'new-terminal' }
  | { name: 'scanner' }
  | { name: 'settings-detail'; section: SettingsSection };
type NewSessionInput = {
  projectPath: string;
  terminalType: string;
  command?: string;
};
type ProjectCardGroup = {
  key: string;
  projectName: string;
  projectPath: string;
  worktreePath: string;
  branchLabel?: string | null;
  cards: CardMeta[];
};

type CloseResultMessage = Extract<
  ServerMessage,
  { kind: 'spawn_result' | 'activate_result' | 'close_result' | 'rename_result' }
>;
type PendingMobileCloseRequest = {
  resolve: (result: TerminalCloseResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const MOBILE_CLOSE_RESPONSE_TIMEOUT_MS = 15_000;

function terminalCloseResultFromMessage(message: CloseResultMessage): TerminalCloseResult {
  const stage =
    message.stage === 'agent_exit'
      ? 'agentExit'
      : message.stage === 'shell_exit'
        ? 'shellExit'
        : message.stage === 'interrupt'
          ? 'interrupt'
          : undefined;
  const outcome =
    message.outcome === 'timed_out'
      ? 'timedOut'
      : message.outcome === 'in_progress'
        ? 'inProgress'
        : message.outcome === 'cancelled'
          ? 'cancelled'
          : message.outcome === 'failed'
            ? 'failed'
            : message.outcome === 'ended' || message.ok
              ? 'ended'
              : 'failed';

  return {
    outcome,
    ...(message.attempt_id ? { attemptId: message.attempt_id } : {}),
    ...(stage ? { stage } : {}),
    ...(message.message ? { message: message.message } : {}),
  };
}

export function App() {
  const { language } = useI18n();
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
  const [serverId, setServerId] = useState(pairing.serverId);
  const [deviceName, setDeviceName] = useState(pairing.deviceName);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  // Monotonic counter bumped ONLY when the server signals backpressure
  // (broadcast Lagged -> error/backpressure -> onLagged). A bump tells
  // MainTerminal to treat the very next terminal_snapshot as a one-shot
  // recovery reset so the dropped terminal_output segment is repainted.
  // Plain reconnects MUST NOT bump
  // this so issue-5 (history survives a reconnect snapshot) is unchanged.
  const [recoveryNonce, setRecoveryNonce] = useState(0);
  const [tab, setTab] = useState<TabId>('workbench');
  const [routeStack, setRouteStack] = useState<MobileRoute[]>([]);
  /** Per-device active tab id within a workspace shell (independent of desktop). */
  const [deviceActiveTabByWorkspace, setDeviceActiveTabByWorkspace] = useState<
    Record<string, string>
  >({});
  const [directTerminalClose, setDirectTerminalClose] = useState<{
    cardId: string;
    title: string;
    phase: TerminalClosePhase;
    attemptId?: string;
    stage?: TerminalCloseResult['stage'];
    message?: string;
  } | null>(null);
  /** Legacy web advertises terminal-only; native secure sets full workspace caps. */
  const bridgeCapabilities: readonly BridgeCapability[] = LEGACY_CAPABILITIES;
  const secureWorkspaceReady = bridgeCapabilities.includes('workspace_tabs');
  const [themePreference, setThemePreference] = useState<MobileThemePreference>(
    themeControllerRef.current.getPreference(),
  );
  const [terminalTheme, setTerminalTheme] = useState<ITheme>(
    themeControllerRef.current.getTerminalTheme(),
  );
  const bridgeSendRef = useRef<((command: ClientCommand) => void) | null>(null);
  const pendingCloseRequestsRef = useRef(new Map<string, PendingMobileCloseRequest>());
  const activeRoute = routeStack[routeStack.length - 1] ?? null;

  const pushRoute = useCallback((route: MobileRoute) => {
    setRouteStack((stack) => [...stack, route]);
  }, []);
  const popRoute = useCallback(() => {
    setRouteStack((stack) => stack.slice(0, -1));
  }, []);
  const clearRoutes = useCallback(() => {
    setRouteStack([]);
  }, []);

  const applyMessage = useCallback((message: ServerMessage) => {
    if (
      message.kind === 'snapshot' &&
      serverId &&
      message.serverId !== serverId
    ) {
      clearPairingStorage();
      setToken(null);
      setPairingError('The connected computer does not match this pairing code.');
      dispatch({
        type: 'ws-error',
        message: 'The connected computer does not match this pairing code.',
      });
      return;
    }
    let shouldArmRecovery = false;
    if (message.kind === 'theme') {
      themeControllerRef.current?.applyServerTheme(message);
      const nextTerminalTheme = themeControllerRef.current?.getTerminalTheme();
      if (nextTerminalTheme) setTerminalTheme(nextTerminalTheme);
    }

    if (message.kind === 'snapshot') {
      const feedState = observeTerminalFeedSnapshot(message);
      retainTerminalFeedCards(message.cards.map((card) => card.id));
      shouldArmRecovery = feedState.runtimeChanged;
    } else if (message.kind === 'card_removed') {
      disposeTerminalFeed(message.card.id);
    } else if (
      message.kind === 'close_result' &&
      message.ok &&
      (message.outcome == null || message.outcome === 'ended') &&
      message.card_id
    ) {
      disposeTerminalFeed(message.card_id);
    }

    if (message.kind === 'close_result') {
      const pending = pendingCloseRequestsRef.current.get(message.request_id);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingCloseRequestsRef.current.delete(message.request_id);
        pending.resolve(terminalCloseResultFromMessage(message));
      }
    }

    if (message.kind === 'terminal_output' || message.kind === 'terminal_snapshot') {
      // Stage 5 (audit P1-3): terminal transport bypasses React state. The
      // per-card feed buckets the chunk and notifies subscribed MainTerminal
      // instances directly, so a hot output stream no longer re-renders the
      // whole App tree per chunk.
      const feedResult = pushTerminalFeedMessage(message);
      shouldArmRecovery ||= feedResult.runtimeChanged || feedResult.needsResync;
      if (feedResult.needsResync) {
        bridgeSendRef.current?.({ kind: 'terminal_resync' });
      }
    }

    if (shouldArmRecovery) {
      setRecoveryNonce((nonce) => nonce + 1);
    }
    dispatch({ type: 'server-message', message });
    if (message.kind === 'spawn_result' && message.ok && message.card_id) {
      dispatch({ type: 'select-card', cardId: message.card_id });
      setTab('workspaces');
      setRouteStack([{ name: 'terminal', cardId: message.card_id }]);
    }
  }, [serverId]);

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
  // a normal reconnect) so the issue-5 reconnect guard stays intact.
  const handleLagged = useCallback(() => {
    setRecoveryNonce((nonce) => nonce + 1);
    void loadSnapshot();
  }, [loadSnapshot]);

  const bridge = useBridgeConnection({
    token,
    onMessage: applyMessage,
    onLagged: handleLagged,
    onError: (message) => dispatch({ type: 'ws-error', message }),
  });
  bridgeSendRef.current = bridge.send;

  const handlePair = useCallback(async () => {
    if (!pairing.otp) return;
    setPairingBusy(true);
    setPairingError(null);
    try {
      const result = await pairDevice(
        pairing.otp,
        deviceName,
        pairing.permission,
        pairing.serverId,
      );
      storePairing(result, deviceName);
      setToken(result.deviceToken);
      setPermission(result.device.permission);
      setServerId(result.serverId);
      scrubPairingCodeFromUrl();
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : String(error));
    } finally {
      setPairingBusy(false);
    }
  }, [deviceName, pairing.otp, pairing.permission, pairing.serverId]);

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
  const canControl = permission === 'full' && bridge.state === 'open';
  const canSend = canControl && Boolean(activeCard && isCardLive(activeCard));

  useEffect(() => {
    if (
      activeRoute?.name === 'terminal' &&
      !state.cards.some((card) => card.id === activeRoute.cardId)
    ) {
      popRoute();
    }
  }, [activeRoute, popRoute, state.cards]);

  const updateThemePreference = (preference: MobileThemePreference) => {
    themeControllerRef.current?.setPreference(preference);
    setThemePreference(preference);
  };

  const openCard = (cardId: string) => {
    dispatch({ type: 'select-card', cardId });
    pushRoute({ name: 'terminal', cardId });
    void loadSnapshot();
  };

  const sendCommand = useCallback((command: ClientCommand): boolean => {
    try {
      bridge.send(command);
      return true;
    } catch (error) {
      dispatch({
        type: 'ws-error',
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }, [bridge]);

  const createRequestId = useCallback(
    (kind: string) => `${kind}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    [],
  );

  const sendCloseCommand = useCallback(
    (
      cardId: string,
      mode: 'graceful' | 'continue' | 'keep' | 'force',
      attemptId?: string,
    ): Promise<TerminalCloseResult> =>
      new Promise((resolve) => {
        const requestId = createRequestId('close');
        const timeout = setTimeout(() => {
          pendingCloseRequestsRef.current.delete(requestId);
          resolve({
            outcome: 'failed',
            ...(attemptId ? { attemptId } : {}),
            message:
              language === 'zh'
                ? '桌面端未及时返回关闭结果，请保留终端后重试。'
                : 'The desktop did not return a close result in time. Keep the terminal and retry.',
          });
        }, MOBILE_CLOSE_RESPONSE_TIMEOUT_MS);

        pendingCloseRequestsRef.current.set(requestId, { resolve, timeout });
        const sent = sendCommand({
          kind: 'close',
          request_id: requestId,
          card_id: cardId,
          mode,
          ...(attemptId ? { attempt_id: attemptId } : {}),
        });
        if (!sent) {
          clearTimeout(timeout);
          pendingCloseRequestsRef.current.delete(requestId);
          resolve({
            outcome: 'failed',
            ...(attemptId ? { attemptId } : {}),
            message:
              language === 'zh'
                ? '关闭请求发送失败，请检查连接后重试。'
                : 'The close request could not be sent. Check the connection and retry.',
          });
        }
      }),
    [createRequestId, language, sendCommand],
  );

  useEffect(
    () => () => {
      for (const pending of pendingCloseRequestsRef.current.values()) {
        clearTimeout(pending.timeout);
        pending.resolve({ outcome: 'cancelled' });
      }
      pendingCloseRequestsRef.current.clear();
    },
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
      const card = state.cards.find((candidate) => candidate.id === cardId);
      if (!card) return;
      const confirmed = window.confirm(
        language === 'zh'
          ? '关闭并删除这个终端？此操作会结束对应会话。'
          : 'Close and delete this terminal? The session will be terminated.',
      );
      if (!confirmed) return;
      setDirectTerminalClose({
        cardId,
        title: card.terminalType || card.projectName || card.id.slice(0, 8),
        phase: 'gracefulEnding',
      });
      void sendCloseCommand(cardId, 'graceful').then(async (result) => {
        if (result.outcome === 'ended' || result.outcome === 'cancelled') {
          setDirectTerminalClose(null);
          return;
        }
        setDirectTerminalClose((current) =>
          current?.cardId === cardId
            ? {
                ...current,
                attemptId: result.attemptId ?? current.attemptId,
                stage: result.stage,
                message: result.message,
                phase:
                  result.outcome === 'timedOut' || result.outcome === 'inProgress'
                    ? 'timedOut'
                    : 'error',
              }
            : current,
        );
      });
    },
    [canControl, language, sendCloseCommand, state.cards],
  );

  const handleDirectTerminalCloseChoice = useCallback(
    async (choice: TerminalCloseChoice) => {
      const request = directTerminalClose;
      if (!request) return;
      if (choice === 'cancel' || choice === 'closeTabOnly') {
        setDirectTerminalClose(null);
        return;
      }
      if (choice === 'keepTerminal' && !canControl) {
        setDirectTerminalClose(null);
        return;
      }

      const mode =
        choice === 'continueWaiting'
          ? 'continue'
          : choice === 'keepTerminal'
            ? 'keep'
            : choice === 'forceEnd'
              ? 'force'
              : 'graceful';
      setDirectTerminalClose({
        ...request,
        phase: mode === 'force' ? 'forcing' : 'gracefulEnding',
        message: undefined,
      });
      const result = await sendCloseCommand(request.cardId, mode, request.attemptId);
      if (
        result.outcome === 'ended' ||
        result.outcome === 'cancelled' ||
        choice === 'keepTerminal'
      ) {
        setDirectTerminalClose(null);
        return;
      }
      setDirectTerminalClose((current) =>
        current?.cardId === request.cardId
          ? {
              ...current,
              attemptId: result.attemptId ?? current.attemptId,
              stage: result.stage,
              message: result.message,
              phase:
                result.outcome === 'timedOut' || result.outcome === 'inProgress'
                  ? 'timedOut'
                  : 'error',
            }
          : current,
      );
    },
    [canControl, directTerminalClose, sendCloseCommand],
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
      const hasCommand = Boolean(command?.trim());
      sendCommand({
        kind: 'spawn',
        request_id: createRequestId('spawn'),
        terminal_type: terminalType,
        project_path: trimmedProjectPath,
        ...(hasCommand ? { command } : {}),
      });
      setTab('workspaces');
      clearRoutes();
    },
    [canControl, clearRoutes, createRequestId, sendCommand],
  );

  const openWorkspace = useCallback(
    (group: ProjectCardGroup) => {
      setRouteStack((stack) => [...stack, { name: 'workspace', workspaceKey: group.key }]);
      setDeviceActiveTabByWorkspace((prev) => ({
        ...prev,
        [group.key]: prev[group.key] ?? 'home',
      }));
    },
    [],
  );

  const handleTerminalCloseChoice = useCallback(
    async (
      choice: TerminalCloseChoice,
      tabId: string,
      cardId: string | null,
      attemptId?: string,
    ): Promise<TerminalCloseResult> => {
      if (choice === 'cancel') return { outcome: 'cancelled' };

      if (choice === 'closeTabOnly') {
        setDeviceActiveTabByWorkspace((prev) => {
          const next = { ...prev };
          for (const [workspaceKey, activeId] of Object.entries(next)) {
            if (activeId === tabId) next[workspaceKey] = 'home';
          }
          return next;
        });
        return { outcome: 'closed' };
      }

      if (choice === 'keepTerminal') {
        if (!cardId || !canControl) return { outcome: 'cancelled', ...(attemptId ? { attemptId } : {}) };
        const result = await sendCloseCommand(cardId, 'keep', attemptId);
        return result.outcome === 'ended'
          ? result
          : { outcome: 'cancelled', ...(result.attemptId ? { attemptId: result.attemptId } : {}) };
      }

      if (!cardId || !canControl) {
        return {
          outcome: 'failed',
          ...(attemptId ? { attemptId } : {}),
          message:
            language === 'zh'
              ? '当前连接没有结束终端的权限。'
              : 'The current connection cannot end this terminal.',
        };
      }

      const mode =
        choice === 'continueWaiting'
          ? 'continue'
          : choice === 'forceEnd'
              ? 'force'
              : 'graceful';
      const result = await sendCloseCommand(cardId, mode, attemptId);
      if (result.outcome === 'ended') {
        setDeviceActiveTabByWorkspace((prev) => {
          const next = { ...prev };
          for (const [workspaceKey, activeId] of Object.entries(next)) {
            if (activeId === tabId) next[workspaceKey] = 'home';
          }
          return next;
        });
      }
      return result;
    },
    [canControl, language, sendCloseCommand],
  );

  const handleDirtyCloseChoice = useCallback(
    (choice: DirtyCloseChoice, _tabId: string) => {
      // Secure v2 save/discard is wired when NativeSecureBridgeClient is active.
      // Legacy web has no draft capability — keep tab open on cancel/readonly.
      if (choice === 'cancel') return;
      if (!secureWorkspaceReady) return;
    },
    [secureWorkspaceReady],
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

  const routeAttention =
    activeRoute?.name === 'attention'
      ? state.workbench?.attentionItems.find((item) => item.id === activeRoute.id) ?? null
      : null;
  const routeGroup =
    activeRoute?.name === 'execution-group'
      ? state.workbench?.executionGroups.find((group) => group.id === activeRoute.id) ?? null
      : null;
  const routeCard =
    activeRoute?.name === 'terminal'
      ? state.cards.find((card) => card.id === activeRoute.cardId) ?? null
      : null;

  return (
    <div className="ios-shell">
      <div className={`mobile-root-layer ${tab === 'workbench' ? 'active' : ''}`} aria-hidden={tab !== 'workbench'}>
        <WorkbenchScreen
          cards={state.cards}
          notifications={state.notifications}
          onOpenAttention={(id) => pushRoute({ name: 'attention', id })}
          onOpenGroup={(id) => pushRoute({ name: 'execution-group', id })}
          onOpenNewTerminal={() => pushRoute({ name: 'new-terminal' })}
          onOpenNotifications={() => pushRoute({ name: 'notifications' })}
          onOpenRules={() => pushRoute({ name: 'rules' })}
          onOpenTerminal={openCard}
          projection={state.workbench}
          warmingUp={state.warmingUp}
          wsStatus={bridge.state}
        />
      </div>

      <div className={`mobile-root-layer ${tab === 'workspaces' ? 'active' : ''}`} aria-hidden={tab !== 'workspaces'}>
        <WorkspacesScreen
          activeCardId={state.activeCardId}
          cards={state.cards}
          canControl={canControl}
          onActivateCard={requestActivate}
          onDeleteCard={requestClose}
          onNewSession={() => pushRoute({ name: 'new-terminal' })}
          onOpenCard={openCard}
          onOpenWorkspace={openWorkspace}
          onRenameCard={requestRenameCard}
          warmingUp={state.warmingUp}
          wsStatus={bridge.state}
        />
      </div>

      <div className={`mobile-root-layer ${tab === 'settings' ? 'active' : ''}`} aria-hidden={tab !== 'settings'}>
        <SettingsScreen
          activeCard={activeCard}
          bridgeAddress={window.location.host}
          lastError={state.lastError}
          notifications={state.notifications}
          onOpenNotifications={() => pushRoute({ name: 'notifications' })}
          onOpenRules={() => pushRoute({ name: 'rules' })}
          onOpenSection={(section) => pushRoute({ name: 'settings-detail', section })}
          onThemePreferenceChange={updateThemePreference}
          permission={permission}
          themePreference={themePreference}
          wsStatus={bridge.state}
        />
      </div>

      {!activeRoute && <TabBar activeTab={tab} onChange={setTab} unreadCount={state.workbench?.summary.attention ?? 0} />}

      {activeRoute && (
        <div className="mobile-route-layer">
          {activeRoute.name === 'scanner' && (
            <ScannerScreen
              bridgeAddress={window.location.host}
              onClose={popRoute}
              permission={permission}
              wsStatus={bridge.state}
            />
          )}
          {activeRoute.name === 'terminal' && (
            <TerminalDetail
              activeCard={routeCard}
              canSend={canSend}
              recoveryNonce={recoveryNonce}
              onBack={popRoute}
              onActivate={requestActivate}
              onCloseCard={requestClose}
              onOpenSettings={() => {
                clearRoutes();
                setTab('settings');
              }}
              onSend={sendInput}
              permission={permission}
              terminalTheme={terminalTheme}
              wsStatus={bridge.state}
            />
          )}
          {activeRoute.name === 'workspace' && (
            <WorkspaceRoute
              cards={state.cards}
              canControl={canControl}
              canSend={canSend}
              deviceActiveTabId={deviceActiveTabByWorkspace[activeRoute.workspaceKey] ?? 'home'}
              permission={permission}
              recoveryNonce={recoveryNonce}
              secureReady={secureWorkspaceReady}
              terminalTheme={terminalTheme}
              workspaceKey={activeRoute.workspaceKey}
              wsStatus={bridge.state}
              onActivateCard={requestActivate}
              onBack={popRoute}
              onDirtyCloseChoice={handleDirtyCloseChoice}
              onNewTerminal={() => pushRoute({ name: 'new-terminal' })}
              onOpenTerminalCard={openCard}
              onSelectTab={(tabId) => {
                setDeviceActiveTabByWorkspace((prev) => ({
                  ...prev,
                  [activeRoute.workspaceKey]: tabId,
                }));
              }}
              onSendInput={sendInput}
              onTerminalCloseChoice={handleTerminalCloseChoice}
            />
          )}
          {activeRoute.name === 'attention' && (
            <AttentionDetailScreen
              item={routeAttention}
              onBack={popRoute}
              onOpenTerminal={openCard}
              terminalAvailable={Boolean(routeAttention && state.cards.some((card) => card.id === routeAttention.cardId))}
              wsStatus={bridge.state}
            />
          )}
          {activeRoute.name === 'execution-group' && (
            <ExecutionGroupDetailScreen
              cards={state.cards}
              group={routeGroup}
              onBack={popRoute}
              onOpenAttention={(id) => pushRoute({ name: 'attention', id })}
              onOpenTerminal={openCard}
              relatedAttention={(state.workbench?.attentionItems ?? []).filter((item) =>
                routeGroup?.cardIds.includes(item.cardId),
              )}
            />
          )}
          {activeRoute.name === 'notifications' && (
            <NotificationsScreen
              notifications={state.notifications}
              onBack={popRoute}
              onOpenTerminal={(cardId) => {
                if (state.cards.some((card) => card.id === cardId)) openCard(cardId);
              }}
            />
          )}
          {activeRoute.name === 'rules' && (
            <RulesScreen onBack={popRoute} projection={state.workbench} />
          )}
          {activeRoute.name === 'new-terminal' && (
            <NewTerminalScreen
              canControl={canControl}
              onBack={popRoute}
              onCreate={requestSpawn}
              permission={permission}
              wsStatus={bridge.state}
            />
          )}
          {activeRoute.name === 'settings-detail' && (
            <SettingsDetailScreen
              activeCard={activeCard}
              bridgeAddress={window.location.host}
              lastError={state.lastError}
              notifications={state.notifications}
              onBack={popRoute}
              onOpenNotifications={() => pushRoute({ name: 'notifications' })}
              onOpenScanner={() => pushRoute({ name: 'scanner' })}
              onOpenRules={() => pushRoute({ name: 'rules' })}
              onRefresh={() => void loadSnapshot()}
              onThemePreferenceChange={updateThemePreference}
              permission={permission}
              projection={state.workbench}
              section={activeRoute.section}
              themePreference={themePreference}
              wsStatus={bridge.state}
            />
          )}
        </div>
      )}

      <TerminalCloseSheet
        open={Boolean(directTerminalClose)}
        title={directTerminalClose?.title ?? ''}
        phase={directTerminalClose?.phase}
        stage={directTerminalClose?.stage}
        message={directTerminalClose?.message}
        canEndTerminal={canControl}
        onChoose={(choice) => {
          void handleDirectTerminalCloseChoice(choice);
        }}
      />
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

function WorkspacesScreen({
  activeCardId,
  cards,
  canControl,
  onActivateCard,
  onDeleteCard,
  onNewSession,
  onOpenCard,
  onOpenWorkspace,
  onRenameCard,
  warmingUp,
  wsStatus,
}: {
  activeCardId: string | null;
  cards: CardMeta[];
  canControl: boolean;
  onActivateCard: (cardId: string) => void;
  onDeleteCard: (cardId: string) => void;
  onNewSession: () => void;
  onOpenCard: (cardId: string) => void;
  onOpenWorkspace: (group: ProjectCardGroup) => void;
  onRenameCard?: (cardId: string, projectName: string) => void;
  warmingUp: boolean;
  wsStatus: BridgeConnectionState;
}) {
  const { language, t } = useI18n();
  const zh = language === 'zh';
  const [searchQuery, setSearchQuery] = useState('');
  const [segment, setSegment] = useState<'active' | 'archived'>('active');
  const [scopeKey, setScopeKey] = useState('all');
  const allGroups = useMemo(() => groupCardsByProject(cards), [cards]);
  const visibleCards = useMemo(() => {
    if (segment === 'archived') return [];
    const searched = filterCards(cards, searchQuery);
    if (scopeKey === 'all') return searched;
    return searched.filter((card) => executionContextKey(card) === scopeKey);
  }, [cards, scopeKey, searchQuery, segment]);
  const groups = groupCardsByProject(visibleCards);

  return (
    <main className="mobile-root-screen">
      <header className="mobile-page-header safe-top">
        <div className="mobile-header-row">
          <div className="mobile-header-title">
            <h1>{t('workspaces.title')}</h1>
            <span>
              {segment === 'archived'
                ? (zh ? '已归档会话' : 'Archived sessions')
                : `${allGroups.length} ${zh ? '个工作树' : 'worktrees'} · ${visibleCards.length} ${zh ? '个会话' : 'sessions'}`}
            </span>
          </div>
          <button
            className="mobile-icon-button filled"
            type="button"
            onClick={onNewSession}
            aria-label={t('instances.newSession')}
            disabled={!canControl}
          >
            <Plus size={22} />
          </button>
        </div>
        <SearchField value={searchQuery} onChange={setSearchQuery} />
        <div className="terminal-filter-row">
          <div className="segmented terminal-segmented">
            <button
              className={segment === 'active' ? 'segmented-active' : ''}
              type="button"
              aria-pressed={segment === 'active'}
              onClick={() => setSegment('active')}
            >
              {zh ? '正在运行' : 'Active'}
            </button>
            <button
              className={segment === 'archived' ? 'segmented-active' : ''}
              type="button"
              aria-pressed={segment === 'archived'}
              onClick={() => setSegment('archived')}
            >
              <Archive size={14} />
              {zh ? '已归档' : 'Archived'}
            </button>
          </div>
          <label className="scope-select compact">
            <Boxes size={15} />
            <span className="sr-only">{zh ? '筛选项目' : 'Filter project'}</span>
            <select value={scopeKey} onChange={(event) => setScopeKey(event.target.value)}>
              <option value="all">{zh ? '全部范围' : 'All scopes'}</option>
              {allGroups.map((group) => (
                <option value={group.key} key={group.key}>
                  {projectGroupDisplayLabel(group)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <ConnectionBanner wsStatus={wsStatus} />
      <div className="mobile-page-content">
        {warmingUp ? (
          <EmptyState label={t('instances.warmingUp')} />
        ) : segment === 'archived' ? (
          <div className="workbench-empty-state">
            <span><Archive size={22} /></span>
            <strong>{zh ? '归档记录尚未同步到移动端' : 'Archived records are not synced yet'}</strong>
            <p>
              {zh
                ? '请在桌面端查看或恢复归档终端；移动端不会伪造本地归档状态。'
                : 'View or restore archived terminals on desktop.'}
            </p>
          </div>
        ) : groups.length === 0 ? (
          <div className="workbench-empty-state">
            <span><Boxes size={22} /></span>
            <strong>{searchQuery ? (zh ? '没有匹配的工作区' : 'No matching workspaces') : (zh ? '还没有工作区' : 'No workspaces yet')}</strong>
            <p>{searchQuery ? (zh ? '尝试更换关键词或项目范围。' : 'Try another keyword or scope.') : t('instances.empty')}</p>
            {!searchQuery && canControl && <button type="button" onClick={onNewSession}>{t('instances.newSession')}</button>}
          </div>
        ) : (
          groups.map((group) => (
            <section className="section-block" key={group.key}>
              <div className="section-heading project-heading">
                <button
                  type="button"
                  className="workspace-group-open"
                  onClick={() => onOpenWorkspace(group)}
                  data-testid={`open-workspace-${group.key}`}
                >
                  <h2>{projectGroupDisplayLabel(group)}</h2>
                  <small>{t('workspaces.open')}</small>
                </button>
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

export function SettingsScreen({
  activeCard,
  bridgeAddress,
  lastError,
  notifications,
  onOpenNotifications,
  onOpenRules,
  onOpenSection,
  onThemePreferenceChange,
  permission,
  themePreference,
  wsStatus,
}: {
  activeCard: CardMeta | null;
  bridgeAddress: string;
  lastError: string | null;
  notifications: NotificationEntry[];
  onOpenNotifications?: () => void;
  onOpenRules?: () => void;
  onOpenSection?: (section: SettingsSection) => void;
  onThemePreferenceChange: (preference: MobileThemePreference) => void;
  permission: string;
  themePreference: MobileThemePreference;
  wsStatus: BridgeConnectionState;
}) {
  const { language, t } = useI18n();
  const zh = language === 'zh';
  const appearanceLabel: Record<MobileThemePreference, string> = {
    auto: t('settings.appearance.auto'),
    dark: t('settings.appearance.dark'),
    light: t('settings.appearance.light'),
  };
  const openSection = (section: SettingsSection) => onOpenSection?.(section);
  const unreadCount = notifications.filter((entry) => entry.read !== true).length;
  return (
    <main className="mobile-root-screen">
      <header className="mobile-page-header safe-top">
        <div className="mobile-header-row">
          <div className="mobile-header-title">
            <h1>{t('settings.title')}</h1>
            <span>{zh ? '移动端偏好与连接' : 'Mobile preferences and connection'}</span>
          </div>
        </div>
      </header>
      <div className="mobile-page-content">
        <button className="settings-hero" type="button" onClick={() => openSection('connection')}>
          <span className="device-avatar"><Monitor size={26} /></span>
          <span>
            <h2>ThreadTerm</h2>
            <small>{connectionStatusLabel(wsStatus, zh)} · {bridgeAddress}</small>
          </span>
          <ChevronRight size={18} />
        </button>

        <section className="mobile-settings-group">
          <h2>{zh ? '连接与权限' : 'Connection & access'}</h2>
          <div className="mobile-settings-list">
            <SettingsNavRow
              icon={<Wifi size={17} />}
              title={zh ? '连接与配对' : 'Connection & pairing'}
              subtitle={zh ? '地址、二维码、状态与快照' : 'Address, QR code, status and snapshot'}
              value={connectionStatusLabel(wsStatus, zh)}
              onClick={() => openSection('connection')}
            />
            <SettingsNavRow
              icon={<ShieldCheck size={17} />}
              title={zh ? '设备权限' : 'Device permission'}
              subtitle={zh ? '查看当前设备可执行的操作范围' : 'Review this device capability'}
              value={permissionLabel(permission, t)}
              onClick={() => openSection('permissions')}
            />
          </div>
        </section>

        <section className="mobile-settings-group">
          <h2>{zh ? '工作台' : 'Workbench'}</h2>
          <div className="mobile-settings-list">
            <SettingsNavRow
              icon={<Bell size={17} />}
              title={zh ? '通知' : 'Notifications'}
              subtitle={zh ? '真实通知历史与介入信号' : 'Notification history and intervention signals'}
              value={unreadCount ? String(unreadCount) : ''}
              onClick={onOpenNotifications ?? (() => openSection('notifications'))}
            />
            <SettingsNavRow
              icon={<Gauge size={17} />}
              title={zh ? '注意力规则' : 'Attention rules'}
              subtitle={zh ? '等待、异常、复核与无进展' : 'Waiting, failures, review and stalled'}
              value={zh ? '桌面同步' : 'Desktop sync'}
              onClick={onOpenRules ?? (() => {})}
            />
          </div>
        </section>

        <section className="mobile-settings-group">
          <h2>{zh ? '偏好' : 'Preferences'}</h2>
          <div className="mobile-settings-list">
            <SettingsNavRow
              icon={<Moon size={17} />}
              title={zh ? '外观' : 'Appearance'}
              subtitle={zh ? '跟随 PC 主题与终端色板' : 'Desktop theme and terminal palette'}
              value={appearanceLabel[themePreference]}
              onClick={() => openSection('appearance')}
            />
            <SettingsNavRow
              icon={<Languages size={17} />}
              title={zh ? '语言' : 'Language'}
              subtitle={zh ? '跟随桌面、中文或 English' : 'Follow desktop, Chinese or English'}
              value={zh ? '简体中文' : 'English'}
              onClick={() => openSection('language')}
            />
          </div>
        </section>

        <section className="mobile-settings-group">
          <h2>{zh ? '支持' : 'Support'}</h2>
          <div className="mobile-settings-list">
            <SettingsNavRow
              icon={<Wrench size={17} />}
              title={zh ? '连接诊断' : 'Connection diagnostics'}
              subtitle={lastError || (zh ? '协议、快照与当前会话状态' : 'Protocol, snapshot and session status')}
              value={lastError ? (zh ? '需检查' : 'Check') : ''}
              onClick={() => openSection('diagnostics')}
            />
            <SettingsNavRow
              icon={<Info size={17} />}
              title={zh ? '关于 ThreadTerm' : 'About ThreadTerm'}
              subtitle={zh ? '版本、能力边界与开源许可' : 'Version, boundaries and licenses'}
              onClick={() => openSection('about')}
            />
          </div>
        </section>

        <section className="settings-quick-theme">
          <h2>{zh ? '快速外观' : 'Quick appearance'}</h2>
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

        <div className="settings-runtime-note">
          <Activity size={16} />
          <span>
            {activeCard
              ? `${activeCard.projectName} · ${displayRuntimeStatus(activeCard)}`
              : (zh ? '当前没有活动终端' : 'No active terminal')}
          </span>
          {lastError && <WifiOff size={16} />}
        </div>
      </div>
    </main>
  );
}

function NewTerminalScreen({
  canControl,
  onBack,
  onCreate,
  permission,
  wsStatus,
}: {
  canControl: boolean;
  onBack: () => void;
  onCreate: (input: NewSessionInput) => void;
  permission: string;
  wsStatus: BridgeConnectionState;
}) {
  const { language, t } = useI18n();
  const zh = language === 'zh';
  return (
    <DetailScaffold title={t('instances.newSession')} onBack={onBack}>
      {!canControl && (
        <div className="mobile-info-card warning">
          <strong>
            {permission !== 'full'
              ? (zh ? '当前设备为只读权限' : 'This device is read-only')
              : (zh ? '桌面连接当前不可用' : 'Desktop connection unavailable')}
          </strong>
          <span>
            {zh
              ? '创建终端需要桌面端在线并授予完全控制权限。'
              : 'Creating a terminal requires an online desktop and full-control permission.'}
          </span>
        </div>
      )}
      <div className="new-terminal-intro">
        <SquareTerminal size={24} />
        <span>
          <strong>{zh ? '创建真实桌面会话' : 'Create a real desktop session'}</strong>
          <small>
            {zh
              ? `命令会通过已认证 Bridge 发送；当前连接：${statusText(wsStatus)}。`
              : `The command is sent through the authenticated Bridge (${statusText(wsStatus)}).`}
          </small>
        </span>
      </div>
      <NewSessionForm disabled={!canControl} onCancel={onBack} onCreate={onCreate} />
    </DetailScaffold>
  );
}

function SettingsDetailScreen({
  activeCard,
  bridgeAddress,
  lastError,
  notifications,
  onBack,
  onOpenNotifications,
  onOpenRules,
  onOpenScanner,
  onRefresh,
  onThemePreferenceChange,
  permission,
  projection,
  section,
  themePreference,
  wsStatus,
}: {
  activeCard: CardMeta | null;
  bridgeAddress: string;
  lastError: string | null;
  notifications: NotificationEntry[];
  onBack: () => void;
  onOpenNotifications: () => void;
  onOpenRules: () => void;
  onOpenScanner: () => void;
  onRefresh: () => void;
  onThemePreferenceChange: (preference: MobileThemePreference) => void;
  permission: string;
  projection: MobileWorkbenchProjection | null;
  section: SettingsSection;
  themePreference: MobileThemePreference;
  wsStatus: BridgeConnectionState;
}) {
  const {
    language,
    preference: languagePreference,
    setPreference: setLanguagePreference,
    t,
  } = useI18n();
  const zh = language === 'zh';
  const titles: Record<SettingsSection, string> = {
    connection: zh ? '连接与配对' : 'Connection & pairing',
    permissions: zh ? '设备权限' : 'Device permission',
    notifications: zh ? '通知设置' : 'Notification settings',
    appearance: zh ? '外观' : 'Appearance',
    language: zh ? '语言' : 'Language',
    diagnostics: zh ? '连接诊断' : 'Connection diagnostics',
    about: zh ? '关于 ThreadTerm' : 'About ThreadTerm',
  };

  return (
    <DetailScaffold title={titles[section]} onBack={onBack}>
      {section === 'connection' && (
        <>
          <div className="settings-hero static">
            <span className="device-avatar"><Monitor size={26} /></span>
            <span>
              <strong>ThreadTerm Desktop</strong>
              <small>{connectionStatusLabel(wsStatus, zh)} · {bridgeAddress}</small>
            </span>
          </div>
          <div className="detail-grid">
            <SettingsMetric label="WebSocket" value={statusText(wsStatus)} />
            <SettingsMetric label={zh ? '协议' : 'Protocol'} value="v1" />
            <SettingsMetric label={zh ? '权限' : 'Permission'} value={permissionLabel(permission, t)} />
            <SettingsMetric
              label={zh ? '快照时间' : 'Snapshot'}
              value={projection ? new Date(projection.generatedAt).toLocaleTimeString() : '—'}
            />
          </div>
          <div className="settings-action-list">
            <button type="button" onClick={onRefresh}>
              <Activity size={18} />
              <span><strong>{zh ? '重新连接并拉取快照' : 'Reconnect and fetch snapshot'}</strong><small>{zh ? '不会改变现有会话' : 'Existing sessions are unchanged'}</small></span>
              <ChevronRight size={17} />
            </button>
            <button type="button" onClick={onOpenScanner}>
              <QrCode size={18} />
              <span><strong>{zh ? '查看配对入口' : 'Open pairing view'}</strong><small>{zh ? '显示当前 Bridge 地址与权限' : 'Show Bridge address and permission'}</small></span>
              <ChevronRight size={17} />
            </button>
            <button type="button" onClick={() => void copyText(bridgeAddress)}>
              <ClipboardCopy size={18} />
              <span><strong>{zh ? '复制连接地址' : 'Copy connection address'}</strong><small>{bridgeAddress}</small></span>
              <ChevronRight size={17} />
            </button>
          </div>
        </>
      )}

      {section === 'permissions' && (
        <>
          <div className="mobile-info-card">
            <strong>{zh ? '权限由桌面端最终校验' : 'Desktop enforces permission'}</strong>
            <span>
              {zh
                ? '更改权限需要在桌面端撤销并重新配对；移动端不会本地提升权限。'
                : 'Changing permission requires revoking and pairing again on desktop.'}
            </span>
          </div>
          <div className="permission-choice-list">
            <div className={permission === 'full' ? 'selected' : ''}>
              <ShieldCheck size={21} />
              <span><strong>{zh ? '完全控制' : 'Full control'}</strong><small>{zh ? '查看输出、发送输入、创建和管理会话' : 'View output, send input, create and manage sessions'}</small></span>
              {permission === 'full' && <CheckCircle2 size={19} />}
            </div>
            <div className={permission !== 'full' ? 'selected' : ''}>
              <EyeIcon />
              <span><strong>{zh ? '只读访问' : 'Read-only access'}</strong><small>{zh ? '查看工作台与终端快照，不改变会话' : 'View snapshots without changing sessions'}</small></span>
              {permission !== 'full' && <CheckCircle2 size={19} />}
            </div>
          </div>
          <div className="mobile-info-card warning">
            <strong>{zh ? '结构化审批仍在桌面端' : 'Structured approvals stay on desktop'}</strong>
            <span>{zh ? '即使拥有完全控制权限，审批和外部写操作也不会在此页面执行。' : 'Full control does not enable approvals on this page.'}</span>
          </div>
        </>
      )}

      {section === 'notifications' && (
        <>
          <div className="mobile-info-card">
            <strong>{zh ? '真实通知镜像' : 'Real notification mirror'}</strong>
            <span>
              {zh
                ? '通知随 Bridge 快照恢复；已读状态当前由桌面端统一管理。'
                : 'Notifications recover with the Bridge snapshot; desktop owns read state.'}
            </span>
          </div>
          <div className="detail-grid">
            <SettingsMetric label={zh ? '通知总数' : 'Notifications'} value={String(notifications.length)} />
            <SettingsMetric label={zh ? '未读' : 'Unread'} value={String(notifications.filter((entry) => entry.read !== true).length)} />
          </div>
          <button className="secondary-full-button" type="button" onClick={onOpenNotifications}>
            <Bell size={17} />
            {zh ? '打开通知中心' : 'Open notification center'}
          </button>
          <p className="field-hint">
            {zh
              ? '系统级通知开关仍由桌面端「通知设置」控制。'
              : 'OS notification preferences remain in desktop Notification Settings.'}
          </p>
        </>
      )}

      {section === 'appearance' && (
        <>
          <section className="mobile-settings-group">
            <h2>{zh ? '界面主题' : 'Interface theme'}</h2>
            <div className="appearance-choice-grid">
              {(['auto', 'dark', 'light'] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  aria-pressed={themePreference === mode}
                  onClick={() => onThemePreferenceChange(mode)}
                >
                  {mode === 'light' ? <Sun size={19} /> : mode === 'dark' ? <Moon size={19} /> : <Monitor size={19} />}
                  <strong>
                    {mode === 'auto'
                      ? (zh ? '跟随 PC' : 'Follow desktop')
                      : mode === 'dark'
                        ? (zh ? '深色' : 'Dark')
                        : (zh ? '浅色' : 'Light')}
                  </strong>
                  <small>
                    {mode === 'auto'
                      ? (zh ? '应用与终端 token 同步' : 'Sync app and terminal tokens')
                      : (zh ? '仅覆盖移动界面模式' : 'Override mobile app mode')}
                  </small>
                </button>
              ))}
            </div>
          </section>
          <div className="mobile-info-card">
            <strong>{zh ? 'PC 主题联动（主题包）' : 'Desktop theme-pack linkage'}</strong>
            <span>
              {zh
                ? '跟随 PC 时直接消费 Bridge 下发的 app + terminal + mode 令牌，不在移动端复制主题包常量。'
                : 'Follow desktop consumes Bridge app + terminal + mode tokens without duplicated theme-pack constants.'}
            </span>
          </div>
          <div className="terminal-theme-preview" aria-label={zh ? '终端主题预览' : 'Terminal theme preview'}>
            <span><i>$</i> threadterm preview</span>
            <span><b>✓</b> {zh ? '主题实时预览' : 'Live theme preview'}</span>
          </div>
        </>
      )}

      {section === 'language' && (
        <>
          <div className="language-choice-list">
            {(['auto', 'zh', 'en'] as const).map((value) => {
              const labels: Record<MobileLanguagePreference, [string, string]> = {
                auto: [zh ? '跟随桌面' : 'Follow desktop', zh ? '使用配对链接中的桌面语言' : 'Use the desktop language from pairing'],
                zh: ['简体中文', 'Chinese (Simplified)'],
                en: ['English', 'English'],
              };
              return (
                <button
                  type="button"
                  key={value}
                  aria-pressed={languagePreference === value}
                  onClick={() => setLanguagePreference(value)}
                >
                  <Languages size={18} />
                  <span><strong>{labels[value][0]}</strong><small>{labels[value][1]}</small></span>
                  {languagePreference === value && <CheckCircle2 size={19} />}
                </button>
              );
            })}
          </div>
        </>
      )}

      {section === 'diagnostics' && (
        <>
          <div className="detail-grid">
            <SettingsMetric label={zh ? '连接' : 'Connection'} value={connectionStatusLabel(wsStatus, zh)} />
            <SettingsMetric label={zh ? '移动协议' : 'Protocol'} value="v1" />
            <SettingsMetric label={zh ? '终端数' : 'Terminals'} value={activeCard ? '1+' : '0'} />
            <SettingsMetric label={zh ? '投影' : 'Projection'} value={projection ? 'ready' : 'missing'} />
          </div>
          {lastError && (
            <div className="mobile-info-card warning">
              <strong>{zh ? '最近错误' : 'Last error'}</strong>
              <span className="breakable-path">{lastError}</span>
            </div>
          )}
          <div className="settings-action-list">
            <button type="button" onClick={onRefresh}>
              <Activity size={18} />
              <span><strong>{zh ? '重新连接并拉取快照' : 'Reconnect and fetch snapshot'}</strong><small>{zh ? '不改变现有会话' : 'Does not change sessions'}</small></span>
              <ChevronRight size={17} />
            </button>
            <button
              type="button"
              onClick={() =>
                void copyText(
                  JSON.stringify(
                    {
                      bridgeAddress,
                      protocol: 1,
                      wsStatus,
                      permission,
                      projectionGeneratedAt: projection?.generatedAt ?? null,
                      notificationCount: notifications.length,
                    },
                    null,
                    2,
                  ),
                )
              }
            >
              <ClipboardCopy size={18} />
              <span><strong>{zh ? '复制脱敏诊断信息' : 'Copy redacted diagnostics'}</strong><small>{zh ? '不包含终端输出和配对令牌' : 'No terminal output or pairing token'}</small></span>
              <ChevronRight size={17} />
            </button>
          </div>
        </>
      )}

      {section === 'about' && (
        <>
          <div className="about-hero">
            <span><SquareTerminal size={30} /></span>
            <h2>ThreadTerm Mobile</h2>
            <p>v0.3 · Bridge Protocol v1</p>
          </div>
          <div className="mobile-info-card">
            <strong>{zh ? '移动工作台' : 'Mobile Workbench'}</strong>
            <span>
              {zh
                ? '用于监管桌面端真实会话、定位确定性信号并在需要时接管终端。'
                : 'Supervise real desktop sessions, locate deterministic signals and take over terminals when needed.'}
            </span>
          </div>
          <div className="settings-action-list">
            <button type="button" onClick={onOpenRules}>
              <Gauge size={18} />
              <span><strong>{zh ? '查看能力边界' : 'Review capability boundaries'}</strong><small>{zh ? '注意力规则与只读约束' : 'Attention rules and read-only constraints'}</small></span>
              <ChevronRight size={17} />
            </button>
            <button type="button" onClick={() => void copyText('ThreadTerm Mobile v0.3 · Bridge Protocol v1')}>
              <ClipboardCopy size={18} />
              <span><strong>{zh ? '复制版本信息' : 'Copy version information'}</strong><small>ThreadTerm Mobile v0.3</small></span>
              <ChevronRight size={17} />
            </button>
          </div>
        </>
      )}
    </DetailScaffold>
  );
}

function SettingsNavRow({
  icon,
  onClick,
  subtitle,
  title,
  value = '',
}: {
  icon: React.ReactNode;
  onClick: () => void;
  subtitle: string;
  title: string;
  value?: string;
}) {
  return (
    <button className="mobile-settings-row" type="button" onClick={onClick}>
      <span className="settings-row-icon">{icon}</span>
      <span><strong>{title}</strong><small>{subtitle}</small></span>
      {value && <em>{value}</em>}
      <ChevronRight size={17} />
    </button>
  );
}

function SettingsMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-field">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EyeIcon() {
  return <Circle size={21} />;
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
  terminalTheme,
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
  terminalTheme: ITheme;
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
        theme={terminalTheme}
      />

      {permission === 'full' ? (
        <>
          {activeCard && !isCardLive(activeCard) && activeCard.attachable && (
            <div className="resume-strip">
              <span>{t('detail.notLive')}</span>
              <button type="button" onClick={() => onActivate(activeCard.id)}>
                <Play size={15} />
                {t('instances.activate')}
              </button>
            </div>
          )}
          <InputBar
            ariaLabel={t('detail.inputLabel')}
            disabled={!canSend}
            onSend={onSend}
          />
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
          {['shell', 'claude', 'codex', 'opencode', 'gemini', 'kimi', 'grok', 'npm', 'yarn', 'pnpm', 'docker', 'python', 'node', 'custom'].map(
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

function TabBar({
  activeTab,
  onChange,
  unreadCount,
}: {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  unreadCount: number;
}) {
  const { t } = useI18n();
  return (
    <footer className="tab-bar safe-bottom">
      <button
        className={activeTab === 'workbench' ? 'tab-active' : ''}
        type="button"
        aria-current={activeTab === 'workbench' ? 'page' : undefined}
        onClick={() => onChange('workbench')}
      >
        <Gauge size={22} />
        <span>{t('tab.workbench')}</span>
        {unreadCount > 0 && <i className="tab-attention-dot" />}
      </button>
      <button
        className={activeTab === 'workspaces' ? 'tab-active' : ''}
        type="button"
        aria-current={activeTab === 'workspaces' ? 'page' : undefined}
        onClick={() => onChange('workspaces')}
      >
        <Boxes size={22} />
        <span>{t('tab.workspaces')}</span>
      </button>
      <button
        className={activeTab === 'settings' ? 'tab-active' : ''}
        type="button"
        aria-current={activeTab === 'settings' ? 'page' : undefined}
        onClick={() => onChange('settings')}
      >
        <Settings size={22} />
        <span>{t('tab.settings')}</span>
      </button>
    </footer>
  );
}

function WorkspaceRoute({
  cards,
  canControl,
  canSend,
  deviceActiveTabId,
  permission,
  recoveryNonce,
  secureReady,
  terminalTheme,
  workspaceKey,
  wsStatus,
  onActivateCard,
  onBack,
  onDirtyCloseChoice,
  onNewTerminal,
  onOpenTerminalCard,
  onSelectTab,
  onSendInput,
  onTerminalCloseChoice,
}: {
  cards: CardMeta[];
  canControl: boolean;
  canSend: boolean;
  deviceActiveTabId: string;
  permission: string;
  recoveryNonce: number;
  secureReady: boolean;
  terminalTheme: ITheme;
  workspaceKey: string;
  wsStatus: BridgeConnectionState;
  onActivateCard: (cardId: string) => void;
  onBack: () => void;
  onDirtyCloseChoice: (choice: DirtyCloseChoice, tabId: string) => void;
  onNewTerminal: () => void;
  onOpenTerminalCard: (cardId: string) => void;
  onSelectTab: (tabId: string) => void;
  onSendInput: (data: string) => void;
  onTerminalCloseChoice: (
    choice: TerminalCloseChoice,
    tabId: string,
    cardId: string | null,
    attemptId?: string,
  ) => Promise<TerminalCloseResult>;
}) {
  const groups = useMemo(() => groupCardsByProject(cards), [cards]);
  const group = useMemo(
    () => groups.find((item) => item.key === workspaceKey) ?? null,
    [groups, workspaceKey],
  );
  const tabs: WorkspaceTab[] = useMemo(() => {
    if (!group) return [];
    return syntheticTabsFromCards({
      workspaceKey,
      projectName: group.projectName,
      worktreePath: group.worktreePath,
      cards: group.cards,
    });
  }, [group, workspaceKey]);

  if (!group) {
    return (
      <DetailScaffold title="Workspace" onBack={onBack}>
        <p className="empty-copy">Workspace is no longer available.</p>
      </DetailScaffold>
    );
  }

  return (
    <WorkspaceShell
      workspaceId={workspaceKey}
      projectName={group.projectName}
      projectPath={group.projectPath}
      worktreePath={group.worktreePath}
      branchLabel={group.branchLabel}
      tabs={tabs}
      deviceActiveTabId={deviceActiveTabId}
      cards={group.cards}
      permission={permission === 'full' ? 'full' : 'read_only'}
      secureReady={secureReady}
      wsStatus={wsStatus}
      terminalTheme={terminalTheme}
      recoveryNonce={recoveryNonce}
      canSend={canSend}
      onBack={onBack}
      onSelectTab={onSelectTab}
      onCloseTab={(tabId) => {
        const tabItem = tabs.find((item) => item.id === tabId);
        if (tabItem?.kind === 'terminal') {
          void onTerminalCloseChoice('closeTabOnly', tabId, tabItem.cardId ?? null);
        }
      }}
      onOpenTerminalCard={onOpenTerminalCard}
      onNewTerminal={canControl ? onNewTerminal : undefined}
      onTerminalCloseChoice={onTerminalCloseChoice}
      onDirtyCloseChoice={onDirtyCloseChoice}
      onSendInput={onSendInput}
      onActivateCard={onActivateCard}
    />
  );
}

function StatusBadge({ status }: { status: BridgeConnectionState | TerminalStatus }) {
  return <span className={`status-badge status-badge-${status}`}>{statusText(status)}</span>;
}

function EmptyState({ label }: { label: string }) {
  return <p className="empty-copy empty-state">{label}</p>;
}

export function clearStoredPairing() {
  clearPairingStorage();
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

export function groupCardsByProject(cards: CardMeta[]): ProjectCardGroup[] {
  const groups = new Map<string, ProjectCardGroup>();
  for (const card of cards) {
    const key = executionContextKey(card);
    const projectPath = card.projectPath || card.worktreePath || 'unknown';
    const worktreePath = card.worktreePath || projectPath;
    const existing = groups.get(key);
    if (existing) {
      existing.cards.push(card);
      existing.branchLabel ??= card.branchLabel;
      continue;
    }
    groups.set(key, {
      key,
      projectName: card.projectName || pathBasename(projectPath),
      projectPath,
      worktreePath,
      branchLabel: card.branchLabel,
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

function executionContextKey(card: CardMeta): string {
  const projectPath = (card.projectPath || card.worktreePath || 'unknown').replace(/[\\/]+$/, '');
  const worktreePath = (card.worktreePath || projectPath).replace(/[\\/]+$/, '');
  return JSON.stringify([projectPath, worktreePath]);
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

export function projectGroupDisplayLabel(
  group: Pick<ProjectCardGroup, 'branchLabel' | 'projectName' | 'projectPath' | 'worktreePath'>,
): string {
  if (
    normalizeComparablePath(group.projectPath) ===
    normalizeComparablePath(group.worktreePath)
  ) {
    return group.projectName;
  }

  const worktreeLabel = worktreeDisplayLabel(group);
  if (
    !worktreeLabel ||
    worktreeLabel.localeCompare(group.projectName, undefined, { sensitivity: 'accent' }) === 0
  ) {
    return group.projectName;
  }
  return `${group.projectName} · ${worktreeLabel}`;
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

function connectionStatusLabel(status: BridgeConnectionState, zh: boolean): string {
  if (status === 'open') return zh ? '已连接' : 'Connected';
  if (status === 'connecting' || status === 'reconnecting') {
    return zh ? '重连中' : 'Reconnecting';
  }
  if (status === 'revoked') return zh ? '需重新配对' : 'Pair again';
  if (status === 'error') return zh ? '连接错误' : 'Connection error';
  return zh ? '离线' : 'Offline';
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Clipboard permission can be denied in non-secure browser contexts.
  }
}

function statusText(status: BridgeConnectionState | TerminalStatus): string {
  return status.replace(/_/g, ' ');
}
