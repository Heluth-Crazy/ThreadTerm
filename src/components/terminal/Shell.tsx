import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ITheme, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { useTranslation } from 'react-i18next';
import { logger } from '../../lib/logger';
import { isTauriEnv, pty } from '../../lib/tauri-bridge';
import { useTheme } from '../../theme/ThemeContext';
import { registerTerminal, unregisterTerminal } from './xtermRegistry';
import { createOutputAcknowledger } from './outputAcknowledger';
import { computeReconnectDelay, formatExitBanner } from './shellBehavior';
import { CODEX_DEVICE_AUTH_URL, isCodexLoginCommand } from './shellAuth';
import { createTerminalOutputPipeline } from './terminalOutputPipeline';
import {
  useTerminalSurfaceController,
  useTerminalSurfaceLifecycle,
} from './useTerminalSurfaceLifecycle';
import {
  createRendererConsumerId,
  disposeRendererConsumer,
  onceUnlisten,
  RENDERER_CONSUMER_HEARTBEAT_MS,
  usePtyOutputLifecycle,
} from './usePtyOutputLifecycle';
import { useXtermLifecycle } from './useXtermLifecycle';
import type {
  DetachCurrentPtyOptions,
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

  const setConnecting = useCallback((value: boolean) => {
    isConnectingRef.current = value;
    setIsConnecting(value);
  }, []);

  const setConnected = useCallback((value: boolean) => {
    isConnectedRef.current = value;
    setIsConnected(value);
  }, []);

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

  const detachCurrentPty = useCallback(({
    clearTerminal = true,
    kill = false,
  }: DetachCurrentPtyOptions = {}) => {
    connectGenerationRef.current += 1;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    retryCountRef.current = 0;
    setRetryAttempt(0);
    setConnectError(null);
    cleanupListeners();

    if (ptyIdRef.current) {
      if (terminal.current) {
        unregisterTerminal(ptyIdRef.current, terminal.current);
      } else {
        unregisterTerminal(ptyIdRef.current);
      }
      if (kill && !preservePtyOnUnmountRef.current) {
        pty.kill(ptyIdRef.current).catch(() => {});
      }
    }

    ptyIdRef.current = null;
    lastPtySizeRef.current = null;
    exitedRef.current = false;
    pendingNewLinesRef.current = 0;
    scrolledUpRef.current = false;
    setExitInfo(null);
    setScrolledUp(false);
    setNewOutputLines(0);

    if (clearTerminal && terminal.current) {
      terminal.current.clear();
      terminal.current.write('\x1b[2J\x1b[H');
    }

    setConnected(false);
    setConnecting(false);
    setAuthUrlCopyStatus('idle');
    setIsAuthPanelDismissed(false);
  }, [cleanupListeners, setConnected, setConnecting]);

  const scheduleReconnect = useCallback((connectPty: () => void) => {
    if (manuallyDisconnected.current) return;
    const delay = computeReconnectDelay(retryCountRef.current);
    retryCountRef.current += 1;
    setRetryAttempt(retryCountRef.current);
    reconnectTimeoutRef.current = setTimeout(() => {
      connectPty();
    }, delay);
  }, []);

  // Flush the buffered "new lines while scrolled up" count into render state
  // at most every 200ms so a fast output burst doesn't re-render per chunk.
  const scheduleNewOutputFlush = useCallback(() => {
    if (newOutputFlushTimerRef.current) return;
    newOutputFlushTimerRef.current = setTimeout(() => {
      newOutputFlushTimerRef.current = null;
      setNewOutputLines(pendingNewLinesRef.current);
    }, 200);
  }, []);

  const connectPty: () => void = useCallback(() => {
    if (isConnectingRef.current || isConnectedRef.current) return;
    const project = selectedProjectRef.current;
    if (!project || !terminal.current) return;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    setConnecting(true);
    const setupGeneration = connectGenerationRef.current + 1;
    connectGenerationRef.current = setupGeneration;

    const setup = async () => {
      let localUnlistenOutput: Unlisten | null = null;
      let localUnlistenExit: Unlisten | null = null;
      let localSequencer: OutputSequencer | null = null;
      let localOutputConsumer: RendererOutputConsumer | null = null;
      const cleanupLocalSetup = () => {
        localUnlistenOutput?.();
        localUnlistenExit?.();
        localSequencer?.reset();
        disposeRendererConsumer(localOutputConsumer);

        if (unlistenOutputRef.current === localUnlistenOutput) {
          unlistenOutputRef.current = null;
        }
        if (unlistenExitRef.current === localUnlistenExit) {
          unlistenExitRef.current = null;
        }
        if (outputSequencerRef.current === localSequencer) {
          outputSequencerRef.current = null;
        }
        if (outputConsumerRef.current === localOutputConsumer) {
          outputConsumerRef.current = null;
        }
      };

      try {
        if (!isTauriEnv()) {
          throw new Error(t('shell.ptyDesktopOnly'));
        }

        const projectPath = project.fullPath || project.path;
        const ptySessionId = paneId || `shell-${Date.now()}`;
        let sessionAlreadyExists = false;
        const isStaleSetup = () =>
          connectGenerationRef.current !== setupGeneration ||
          (paneId && desiredPaneIdRef.current !== paneId);

        try {
          await pty.getSessionState(ptySessionId);
          sessionAlreadyExists = true;
        } catch {
          sessionAlreadyExists = false;
        }
        if (isStaleSetup() || !terminal.current) return;

        cleanupListeners();

        const rows = terminal.current?.rows || 24;
        const cols = terminal.current?.cols || 120;
        const connectedPtyId = await pty.create(ptySessionId, projectPath, rows, cols);
        if (isStaleSetup() || !terminal.current) return;
        const consumerId = createRendererConsumerId(rendererScope);
        await pty.registerOutputConsumer(connectedPtyId, consumerId);
        if (isStaleSetup() || !terminal.current) {
          await pty.unregisterOutputConsumer(connectedPtyId, consumerId).catch(() => {});
          return;
        }
        const outputAcknowledger = createOutputAcknowledger((request) =>
          pty.ack(
            request.id,
            request.throughSeq,
            request.consumerKind,
            request.consumerId,
          ),
        );
        localOutputConsumer = {
          ptyId: connectedPtyId,
          consumerId,
          acknowledger: outputAcknowledger,
          heartbeatTimer: null,
          needsSnapshotRecovery: false,
          recoveryPromise: null,
          disposed: false,
        };
        localOutputConsumer.heartbeatTimer = window.setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          if (localOutputConsumer?.needsSnapshotRecovery) {
            void restoreOutputConsumerFromSnapshot(localOutputConsumer);
            return;
          }
          void pty.registerOutputConsumer(connectedPtyId, consumerId).catch(() => {});
        }, RENDERER_CONSUMER_HEARTBEAT_MS);
        outputConsumerRef.current = localOutputConsumer;
        ptyIdRef.current = connectedPtyId;
        if (terminal.current && connectedPtyId) {
          registerTerminal(connectedPtyId, terminal.current);
        }

        const sequencer = createTerminalOutputPipeline({
          connectedPtyId,
          consumerId,
          outputAcknowledger,
          isStaleSetup,
          terminalRef: terminal,
          outputConsumerRef,
          activeRef,
          scrolledUpRef,
          pendingNewLinesRef,
          setScrolledUp,
          scrollTerminalToBottom,
          scheduleNewOutputFlush,
          scheduleTerminalRefresh,
        });
        localSequencer = sequencer;
        outputSequencerRef.current = sequencer;
        sequencer.reset();

        const unlistenOut = onceUnlisten(await pty.onOutput(({ id: sid, data, seq }) => {
          if (
            sid !== connectedPtyId ||
            ptyIdRef.current !== connectedPtyId ||
            !terminal.current
          ) {
            return;
          }
          sequencer.receive({ seq, data });
        }));
        localUnlistenOutput = unlistenOut;
        if (isStaleSetup() || !terminal.current) {
          cleanupLocalSetup();
          return;
        }

        const unlistenExit = onceUnlisten(await pty.onExit(({ id: sid, code }) => {
          if (sid !== connectedPtyId || ptyIdRef.current !== connectedPtyId) return;
          setConnected(false);
          setConnecting(false);
          // Audit P1-2: never wipe the viewport on exit — the final output
          // (panic, stack trace, exit reason) is exactly what the user needs
          // to see. Append a coloured banner instead.
          const term = terminal.current;
          if (term) {
            const label =
              typeof code === 'number'
                ? t('shell.exitBannerCode', { code })
                : t('shell.exitBannerClosed');
            term.write(formatExitBanner(code ?? null, label));
          }
          if (autoReconnectOnExitRef.current) {
            scheduleReconnect(connectPty);
          } else {
            // Block the autoConnect effect from silently respawning the
            // session; the user restarts explicitly via the exit strip (or
            // the auto-restart feature assigns a fresh ptyId, which clears
            // this gate).
            exitedRef.current = true;
            setExitInfo({ code: typeof code === 'number' ? code : null });
          }
        }));
        localUnlistenExit = unlistenExit;
        if (isStaleSetup() || !terminal.current) {
          cleanupLocalSetup();
          return;
        }

        unlistenOutputRef.current = unlistenOut;
        unlistenExitRef.current = unlistenExit;

        try {
          const snapshot = await pty.attachSnapshot(connectedPtyId);
          if (isStaleSetup() || !terminal.current) {
            cleanupLocalSetup();
            return;
          }
          if (snapshot) {
            if (terminal.current) {
              terminal.current.clear();
              terminal.current.write('\x1b[2J\x1b[H');
              if (snapshot.rows && snapshot.cols) {
                terminal.current.resize(snapshot.cols, snapshot.rows);
                lastPtySizeRef.current = { rows: snapshot.rows, cols: snapshot.cols };
              }
            }
            sequencer.applySnapshot({
              seq: snapshot.seq,
              data: `${snapshot.history || ''}${snapshot.data || ''}`,
            });
          } else {
            sequencer.applySnapshot({ seq: 0, data: '' });
          }
        } catch (error) {
          if (isStaleSetup() || !terminal.current) {
            cleanupLocalSetup();
            return;
          }
          // A registered renderer with no snapshot watermark would keep ACK 0
          // alive via heartbeat and permanently pin an already-backpressured
          // PTY. Tear down this consumer and let the normal reconnect path
          // retry the atomic attach instead of reporting a false connection.
          cleanupLocalSetup();
          throw error;
        }

        setConnected(true);
        setConnecting(false);
        retryCountRef.current = 0;
        setRetryAttempt(0);
        setConnectError(null);
        recoverTerminalSurface(true, true);

        const command = initialCommandRef.current?.trim();
        const shouldSendInitialCommand =
          command &&
          !(suppressInitialCommandWhenPtyExistsRef.current && sessionAlreadyExists);

        if (shouldSendInitialCommand) {
          await pty.input(connectedPtyId, `${command}\r`);
          if (isStaleSetup()) {
            cleanupLocalSetup();
            return;
          }
          onInitialCommandSentRef.current?.();
        }
      } catch (error) {
        cleanupLocalSetup();
        if (connectGenerationRef.current !== setupGeneration) return;
        logger.error('[Shell] PTY connection failed:', error);
        setConnectError(error instanceof Error ? error.message : String(error));
        setConnected(false);
        setConnecting(false);
        scheduleReconnect(connectPty);
      }
    };

    setup();
  }, [
    cleanupListeners,
    paneId,
    recoverTerminalSurface,
    rendererScope,
    restoreOutputConsumerFromSnapshot,
    scheduleNewOutputFlush,
    scheduleReconnect,
    scheduleTerminalRefresh,
    scrollTerminalToBottom,
    setConnected,
    setConnecting,
    t,
  ]);

  const connectToShell = useCallback(() => {
    if (!isInitialized || isConnectedRef.current || isConnectingRef.current) return;
    manuallyDisconnected.current = false;
    connectPty();
  }, [connectPty, isInitialized]);

  const disconnectFromShell = useCallback(() => {
    manuallyDisconnected.current = true;
    detachCurrentPty({ clearTerminal: true, kill: true });
  }, [detachCurrentPty]);

  const restartShell = useCallback(() => {
    setIsRestarting(true);
    disconnectFromShell();
    manuallyDisconnected.current = false;

    if (terminal.current) {
      terminal.current.dispose();
      terminal.current = null;
      fitAddon.current = null;
    }

    setIsInitialized(false);
    setTimeout(() => {
      setIsRestarting(false);
    }, 200);
  }, [disconnectFromShell]);

  // Audit P1-2: explicit user restart after the session exited. This is the
  // only path (besides a fresh ptyId from auto-restart) that clears the
  // screen — the user has read the exit banner and asked for a new session.
  const restartAfterExit = useCallback(() => {
    exitedRef.current = false;
    setExitInfo(null);
    retryCountRef.current = 0;
    setRetryAttempt(0);
    setConnectError(null);
    manuallyDisconnected.current = false;
    const term = terminal.current;
    if (term) {
      term.clear();
      term.write('\x1b[2J\x1b[H');
    }
    connectToShell();
  }, [connectToShell]);

  // Audit P1-4: skip the backoff wait and reconnect immediately.
  const retryConnectNow = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    retryCountRef.current = 0;
    setRetryAttempt(0);
    manuallyDisconnected.current = false;
    connectPty();
  }, [connectPty]);

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

  // A fresh ptyId (auto-restart feature, or a different card reusing this
  // Shell) clears the exit gate so the autoConnect effect below may run.
  // Defined BEFORE the autoConnect effect — same-commit effect order matters.
  useEffect(() => {
    exitedRef.current = false;
    setExitInfo(null);
    retryCountRef.current = 0;
    setRetryAttempt(0);
    setConnectError(null);
  }, [paneId]);

  useEffect(() => {
    if (!isInitialized || !paneId) return;
    if (ptyIdRef.current === paneId) return;
    if (!ptyIdRef.current && !isConnectingRef.current && !isConnectedRef.current) return;

    manuallyDisconnected.current = false;
    detachCurrentPty({ clearTerminal: true, kill: false });
  }, [detachCurrentPty, isInitialized, paneId]);

  useEffect(() => {
    if (!autoConnect || !isInitialized) return;
    if (isConnectingRef.current || isConnectedRef.current) return;
    if (manuallyDisconnected.current) return;
    // Audit P1-2: after a PTY exit the session stays down (banner + restart
    // strip) instead of silently respawning with a cleared screen.
    if (exitedRef.current) return;
    // A failed connect already scheduled a backoff retry; re-triggering here
    // would bypass the backoff and spin connect→fail→connect synchronously.
    if (reconnectTimeoutRef.current) return;
    connectToShell();
  }, [autoConnect, isInitialized, isConnecting, isConnected, connectToShell]);

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
