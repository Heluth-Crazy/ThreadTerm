import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ITheme, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { CODEX_DEVICE_AUTH_URL, isCodexLoginCommand } from './shellAuth';
import {
  useTerminalSurfaceController,
  useTerminalSurfaceLifecycle,
} from './useTerminalSurfaceLifecycle';
import {
  usePtyConnectionController,
  usePtyConnectionLifecycle,
} from './usePtyConnectionLifecycle';
import { usePtyOutputLifecycle } from './usePtyOutputLifecycle';
import { useXtermLifecycle } from './useXtermLifecycle';
import type {
  OutputSequencer,
  RendererOutputConsumer,
  ShellExitInfo,
  ShellProject,
  ShellProps,
  TerminalSize,
  Unlisten,
} from './shellRuntimeTypes';

export type { ShellProps } from './shellRuntimeTypes';

const xtermStyles = `
  .xterm .xterm-screen {
    outline: none !important;
  }
  .xterm:focus .xterm-screen {
    outline: none !important;
  }
  .xterm-screen:focus {
    outline: none !important;
  }
  .threadterm-xterm-host {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .threadterm-xterm-host .xterm {
    width: 100%;
    height: 100%;
  }
  .threadterm-xterm-host .xterm-viewport {
    background-color: var(--terminal-background, #1e1e1e) !important;
  }
`;

if (typeof document !== 'undefined' && !document.getElementById('threadterm-xterm-styles')) {
  const styleSheet = document.createElement('style');
  styleSheet.id = 'threadterm-xterm-styles';
  styleSheet.type = 'text/css';
  styleSheet.innerText = xtermStyles;
  document.head.appendChild(styleSheet);
}

function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') return false;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

function Shell({
  selectedProject,
  initialCommand,
  minimal = false,
  autoConnect = false,
  paneId,
  onDisconnect,
  active = true,
  rendererScope = 'main',
  preservePtyOnUnmount = false,
  suppressInitialCommandWhenPtyExists = false,
  autoReconnectOnExit = true,
  onInitialCommandSent,
  onUserSubmit,
}: ShellProps) {
  const { t } = useTranslation('terminal');
  const { terminalTheme, activeThemeTokens } = useTheme();
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const terminalThemeRef = useRef<ITheme>(terminalTheme);
  const fitAddon = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const unlistenOutputRef = useRef<Unlisten | null>(null);
  const unlistenExitRef = useRef<Unlisten | null>(null);
  const retryCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manuallyDisconnected = useRef(false);
  const lastPtySizeRef = useRef<TerminalSize | null>(null);
  const outputSequencerRef = useRef<OutputSequencer | null>(null);
  const outputConsumerRef = useRef<RendererOutputConsumer | null>(null);
  const connectGenerationRef = useRef(0);
  const desiredPaneIdRef = useRef<string | undefined>(paneId);

  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isAuthPanelDismissed, setIsAuthPanelDismissed] = useState(false);
  const [authUrlCopyStatus, setAuthUrlCopyStatus] = useState<
    'idle' | 'copied' | 'failed'
  >('idle');
  // Audit P1-2: PTY exited while autoReconnectOnExit is off — wait for an
  // explicit user restart instead of silently respawning + clearing.
  const [exitInfo, setExitInfo] = useState<ShellExitInfo | null>(null);
  const exitedRef = useRef(false);
  // Audit P1-4: surface the reconnect loop in minimal mode instead of a
  // silent black screen. retryAttempt mirrors retryCountRef for rendering.
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [connectError, setConnectError] = useState<string | null>(null);
  // Audit P0-1: "N new lines below" indicator while the user reads history.
  const [scrolledUp, setScrolledUp] = useState(false);
  const [newOutputLines, setNewOutputLines] = useState(0);
  const scrolledUpRef = useRef(false);
  const pendingNewLinesRef = useRef(0);
  const newOutputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedProjectRef = useRef<ShellProject | null | undefined>(selectedProject);
  const initialCommandRef = useRef<string | undefined>(initialCommand);
  const onInitialCommandSentRef = useRef<(() => void) | undefined>(onInitialCommandSent);
  const onUserSubmitRef = useRef<(() => void) | undefined>(onUserSubmit);
  const activeRef = useRef(active);
  const preservePtyOnUnmountRef = useRef(preservePtyOnUnmount);
  const autoReconnectOnExitRef = useRef(autoReconnectOnExit);
  const suppressInitialCommandWhenPtyExistsRef = useRef(suppressInitialCommandWhenPtyExists);
  const isConnectingRef = useRef(false);
  const isConnectedRef = useRef(false);
  const terminalShellStyle = useMemo(
    () => ({
      backgroundColor: activeThemeTokens.terminal.background,
      color: activeThemeTokens.terminal.foreground,
    }),
    [activeThemeTokens.terminal.background, activeThemeTokens.terminal.foreground],
  );

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
    initialCommandRef.current = initialCommand;
    onInitialCommandSentRef.current = onInitialCommandSent;
    onUserSubmitRef.current = onUserSubmit;
    activeRef.current = active;
    desiredPaneIdRef.current = paneId;
    preservePtyOnUnmountRef.current = preservePtyOnUnmount;
    autoReconnectOnExitRef.current = autoReconnectOnExit;
    suppressInitialCommandWhenPtyExistsRef.current = suppressInitialCommandWhenPtyExists;
  });

  useEffect(() => {
    terminalThemeRef.current = terminalTheme;
    if (!terminal.current) return;

    terminal.current.options.theme = terminalTheme;
    try {
      terminal.current.refresh(0, Math.max(0, terminal.current.rows - 1));
    } catch {
      // Best-effort repaint when xterm is hidden during a theme switch.
    }
  }, [terminalTheme]);

  const {
    restoreOutputConsumerFromSnapshot,
    cleanupListeners,
  } = usePtyOutputLifecycle({
    terminalRef: terminal,
    ptyIdRef,
    unlistenOutputRef,
    unlistenExitRef,
    outputSequencerRef,
    outputConsumerRef,
    lastPtySizeRef,
    scrolledUpRef,
    pendingNewLinesRef,
    setScrolledUp,
    setNewOutputLines,
  });

  const {
    resizePtyIfNeeded,
    scrollTerminalToBottom,
    cancelSurfaceRecovery,
    scheduleTerminalRefresh,
    recoverTerminalSurface,
    scrollToBottomNow,
    focusTerminal,
  } = useTerminalSurfaceController({
    active,
    activeRef,
    terminalHostRef: terminalRef,
    terminalRef: terminal,
    fitAddonRef: fitAddon,
    ptyIdRef,
    lastPtySizeRef,
    scrolledUpRef,
    pendingNewLinesRef,
    setScrolledUp,
    setNewOutputLines,
  });

  const {
    detachCurrentPty,
    connectToShell,
    restartShell,
    restartAfterExit,
    retryConnectNow,
  } = usePtyConnectionController({
    paneId,
    rendererScope,
    isInitialized,
    t,
    terminalRef: terminal,
    fitAddonRef: fitAddon,
    ptyIdRef,
    unlistenOutputRef,
    unlistenExitRef,
    retryCountRef,
    reconnectTimeoutRef,
    manuallyDisconnectedRef: manuallyDisconnected,
    lastPtySizeRef,
    outputSequencerRef,
    outputConsumerRef,
    connectGenerationRef,
    desiredPaneIdRef,
    selectedProjectRef,
    initialCommandRef,
    onInitialCommandSentRef,
    activeRef,
    preservePtyOnUnmountRef,
    autoReconnectOnExitRef,
    suppressInitialCommandWhenPtyExistsRef,
    isConnectingRef,
    isConnectedRef,
    exitedRef,
    scrolledUpRef,
    pendingNewLinesRef,
    newOutputFlushTimerRef,
    setIsConnected,
    setIsConnecting,
    setIsRestarting,
    setIsInitialized,
    setExitInfo,
    setRetryAttempt,
    setConnectError,
    setScrolledUp,
    setNewOutputLines,
    setAuthUrlCopyStatus,
    setIsAuthPanelDismissed,
    cleanupListeners,
    restoreOutputConsumerFromSnapshot,
    recoverTerminalSurface,
    scrollTerminalToBottom,
    scheduleTerminalRefresh,
  });

  const openAuthUrlInBrowser = useCallback((url: string): boolean => {
    if (!url) return false;
    const popup = window.open(url, '_blank', 'noopener,noreferrer');
    if (!popup) return false;
    try {
      popup.opener = null;
    } catch {
      // Ignore cross-origin restrictions when trying to null opener.
    }
    return true;
  }, []);

  const copyAuthUrlToClipboard = useCallback(async (url: string): Promise<boolean> => {
    if (!url) return false;

    let copied = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied) copied = fallbackCopyToClipboard(url);
    return copied;
  }, []);

  useXtermLifecycle({
    selectedProjectRef,
    projectPath: selectedProject?.path,
    projectFullPath: selectedProject?.fullPath,
    isRestarting,
    minimal,
    terminalHostRef: terminalRef,
    terminalRef: terminal,
    terminalThemeRef,
    fitAddonRef: fitAddon,
    ptyIdRef,
    initialCommandRef,
    onUserSubmitRef,
    activeRef,
    preservePtyOnUnmountRef,
    connectGenerationRef,
    reconnectTimeoutRef,
    retryCountRef,
    newOutputFlushTimerRef,
    pendingNewLinesRef,
    scrolledUpRef,
    lastPtySizeRef,
    setScrolledUp,
    setNewOutputLines,
    setIsInitialized,
    copyAuthUrlToClipboard,
    cleanupListeners,
    cancelSurfaceRecovery,
    recoverTerminalSurface,
    resizePtyIfNeeded,
    scheduleTerminalRefresh,
    scrollTerminalToBottom,
    restoreOutputConsumerFromSnapshot,
  });

  useTerminalSurfaceLifecycle({
    active,
    isInitialized,
    isConnected,
    terminalRef: terminal,
    ptyIdRef,
    lastPtySizeRef,
    outputConsumerRef,
    recoverTerminalSurface,
    restoreOutputConsumerFromSnapshot,
  });

  usePtyConnectionLifecycle({
    paneId,
    autoConnect,
    isInitialized,
    isConnecting,
    isConnected,
    ptyIdRef,
    isConnectingRef,
    isConnectedRef,
    manuallyDisconnectedRef: manuallyDisconnected,
    exitedRef,
    reconnectTimeoutRef,
    retryCountRef,
    setExitInfo,
    setRetryAttempt,
    setConnectError,
    detachCurrentPty,
    connectToShell,
  });

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-gray-400">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-800">
            <svg className="h-8 w-8 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-semibold">{t('shell.selectProject')}</h3>
          <p>{t('shell.selectProjectDescription')}</p>
        </div>
      </div>
    );
  }

  const displayAuthUrl = isCodexLoginCommand(initialCommand) ? CODEX_DEVICE_AUTH_URL : '';
  const showAuthPanel = Boolean(displayAuthUrl) && !isAuthPanelDismissed;
  const showAuthPanelToggle = Boolean(displayAuthUrl) && isAuthPanelDismissed;

  if (minimal) {
    return (
      <div
        className="relative h-full w-full"
        style={terminalShellStyle}
        onMouseDown={focusTerminal}
      >
        <div
          ref={terminalRef}
          data-terminal-context-menu
          className="threadterm-xterm-host focus:outline-none"
          style={{ outline: 'none' }}
        />
        {scrolledUp && (
          <button
            type="button"
            data-testid="shell-scroll-to-bottom"
            onClick={scrollToBottomNow}
            className={[
              'absolute left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-gray-900/90 px-3 py-1.5 text-[11px] font-medium text-gray-100 shadow-lg backdrop-blur-sm hover:bg-gray-700',
              exitInfo !== null || (!isConnected && retryAttempt > 0) ? 'bottom-12' : 'bottom-3',
            ].join(' ')}
          >
            ↓{' '}
            {newOutputLines > 0
              ? t('shell.newLinesBelow', { count: newOutputLines })
              : t('shell.scrollToBottom')}
          </button>
        )}
        {exitInfo !== null && (
          <div
            data-testid="shell-exit-strip"
            className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-border bg-gray-900/90 px-3 py-2 backdrop-blur-sm"
          >
            <span className="min-w-0 truncate text-xs text-gray-300">
              {typeof exitInfo.code === 'number'
                ? t('shell.sessionExitedWithCode', { code: exitInfo.code })
                : t('shell.sessionExited')}
            </span>
            <button
              type="button"
              onClick={restartAfterExit}
              className="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              {t('shell.restartSession')}
            </button>
          </div>
        )}
        {exitInfo === null && !isConnected && retryAttempt > 0 && (
          <div
            data-testid="shell-reconnect-strip"
            className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-border bg-gray-900/90 px-3 py-2 backdrop-blur-sm"
          >
            <span
              className="flex min-w-0 items-center gap-2 text-xs text-amber-300"
              title={connectError ?? undefined}
            >
              <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-amber-300 border-t-transparent" />
              <span className="truncate">
                {connectError
                  ? t('shell.connectionError', { error: connectError })
                  : t('shell.reconnectAttempt', { attempt: retryAttempt })}
              </span>
            </span>
            <button
              type="button"
              onClick={retryConnectNow}
              className="shrink-0 rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-600"
            >
              {t('shell.retryNow')}
            </button>
          </div>
        )}
        {showAuthPanel && (
          <div className="absolute bottom-3 right-3 z-20 w-[min(420px,calc(100%-1.5rem))] rounded-lg border border-gray-700/80 bg-gray-900/95 p-3 shadow-xl backdrop-blur-sm">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-gray-300">{t('shell.authPrompt')}</p>
                <button
                  type="button"
                  onClick={() => setIsAuthPanelDismissed(true)}
                  className="rounded bg-gray-700 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-100 hover:bg-gray-600"
                >
                  {t('shell.dismiss')}
                </button>
              </div>
              <input
                type="text"
                value={displayAuthUrl}
                readOnly
                onClick={(event) => event.currentTarget.select()}
                className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                aria-label={t('shell.authUrlLabel')}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openAuthUrlInBrowser(displayAuthUrl)}
                  className="flex-1 rounded bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700"
                >
                  {t('shell.openInBrowser')}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const copied = await copyAuthUrlToClipboard(displayAuthUrl);
                    setAuthUrlCopyStatus(copied ? 'copied' : 'failed');
                  }}
                  className="flex-1 rounded bg-gray-700 px-3 py-2 text-xs font-medium text-white hover:bg-gray-600"
                >
                  {authUrlCopyStatus === 'copied' ? t('shell.copied') : t('shell.copyUrl')}
                </button>
              </div>
            </div>
          </div>
        )}
        {showAuthPanelToggle && (
          <div className="absolute bottom-3 right-3 z-20">
            <button
              type="button"
              onClick={() => setIsAuthPanelDismissed(false)}
              className="rounded bg-gray-800/95 px-3 py-2 text-xs font-medium text-gray-100 shadow-lg backdrop-blur-sm hover:bg-gray-700"
            >
              {t('shell.showLoginUrl')}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col"
      style={terminalShellStyle}
      onMouseDown={focusTerminal}
    >
      <div className="flex-shrink-0 border-b border-gray-700 bg-gray-800 px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-xs text-gray-400">
              {!isInitialized
                ? t('shell.initializing')
                : isConnecting
                  ? t('shell.connecting')
                  : isConnected
                    ? t('shell.connected')
                    : t('shell.disconnected')}
            </span>
            {isRestarting && <span className="text-xs text-blue-400">{t('shell.restarting')}</span>}
          </div>
          <div className="flex items-center gap-3">
            {isConnected && (
              <button
                type="button"
                onClick={() => {
                  onDisconnect?.();
                  restartShell();
                }}
                className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
              >
                {t('shell.disconnect')}
              </button>
            )}
            <button
              type="button"
              onClick={restartShell}
              disabled={isRestarting || isConnected}
              className="text-xs text-gray-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('shell.restart')}
            </button>
          </div>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden p-2">
        <div
          ref={terminalRef}
          data-terminal-context-menu
          className="threadterm-xterm-host focus:outline-none"
          style={{ outline: 'none' }}
        />

        {!isInitialized && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/90">
            <div className="text-white">{t('shell.loading')}</div>
          </div>
        )}

        {isInitialized && !isConnected && !isConnecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/90 p-4">
            <div className="w-full max-w-sm text-center">
              <button
                type="button"
                onClick={restartShell}
                className="rounded-md bg-green-600 px-6 py-3 text-base font-medium text-white transition-colors hover:bg-green-700"
              >
                {t('shell.connect')}
              </button>
              <p className="mt-3 text-sm text-gray-400">
                {t('shell.runInProject', {
                  action: initialCommand
                    ? t('shell.runCommand', { command: initialCommand })
                    : t('shell.startShell'),
                  project: selectedProject.name,
                })}
              </p>
            </div>
          </div>
        )}

        {isConnecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/90 p-4">
            <div className="text-center">
              <div className="flex items-center justify-center gap-3 text-yellow-400">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-yellow-400 border-t-transparent" />
                <span className="text-base font-medium">{t('shell.connecting')}...</span>
              </div>
              <p className="mt-3 text-sm text-gray-400">
                {t('shell.runInProject', {
                  action: initialCommand
                    ? t('shell.runCommand', { command: initialCommand })
                    : t('shell.startShell'),
                  project: selectedProject.name,
                })}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(Shell);
