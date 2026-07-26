import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { TFunction } from 'i18next';
import { logger } from '../../lib/logger';
import { isTauriEnv, pty } from '../../lib/tauri-bridge';
import { createOutputAcknowledger } from './outputAcknowledger';
import { computeReconnectDelay, formatExitBanner } from './shellBehavior';
import { createTerminalOutputPipeline } from './terminalOutputPipeline';
import {
  createRendererConsumerId,
  disposeRendererConsumer,
  onceUnlisten,
  RENDERER_CONSUMER_HEARTBEAT_MS,
} from './usePtyOutputLifecycle';
import { registerTerminal, unregisterTerminal } from './xtermRegistry';
import type {
  DetachCurrentPtyOptions,
  OutputSequencer,
  RendererOutputConsumer,
  ShellExitInfo,
  ShellProject,
  TerminalSize,
  Unlisten,
} from './shellRuntimeTypes';

interface UsePtyConnectionControllerOptions {
  paneId?: string;
  rendererScope: string;
  isInitialized: boolean;
  t: TFunction<'terminal'>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  ptyIdRef: MutableRefObject<string | null>;
  unlistenOutputRef: MutableRefObject<Unlisten | null>;
  unlistenExitRef: MutableRefObject<Unlisten | null>;
  retryCountRef: MutableRefObject<number>;
  reconnectTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  manuallyDisconnectedRef: MutableRefObject<boolean>;
  lastPtySizeRef: MutableRefObject<TerminalSize | null>;
  outputSequencerRef: MutableRefObject<OutputSequencer | null>;
  outputConsumerRef: MutableRefObject<RendererOutputConsumer | null>;
  connectGenerationRef: MutableRefObject<number>;
  desiredPaneIdRef: MutableRefObject<string | undefined>;
  selectedProjectRef: MutableRefObject<ShellProject | null | undefined>;
  initialCommandRef: MutableRefObject<string | undefined>;
  onInitialCommandSentRef: MutableRefObject<(() => void) | undefined>;
  activeRef: MutableRefObject<boolean>;
  preservePtyOnUnmountRef: MutableRefObject<boolean>;
  autoReconnectOnExitRef: MutableRefObject<boolean>;
  suppressInitialCommandWhenPtyExistsRef: MutableRefObject<boolean>;
  isConnectingRef: MutableRefObject<boolean>;
  isConnectedRef: MutableRefObject<boolean>;
  exitedRef: MutableRefObject<boolean>;
  scrolledUpRef: MutableRefObject<boolean>;
  pendingNewLinesRef: MutableRefObject<number>;
  newOutputFlushTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setIsConnected: Dispatch<SetStateAction<boolean>>;
  setIsConnecting: Dispatch<SetStateAction<boolean>>;
  setIsRestarting: Dispatch<SetStateAction<boolean>>;
  setIsInitialized: Dispatch<SetStateAction<boolean>>;
  setExitInfo: Dispatch<SetStateAction<ShellExitInfo | null>>;
  setRetryAttempt: Dispatch<SetStateAction<number>>;
  setConnectError: Dispatch<SetStateAction<string | null>>;
  setScrolledUp: Dispatch<SetStateAction<boolean>>;
  setNewOutputLines: Dispatch<SetStateAction<number>>;
  setAuthUrlCopyStatus: Dispatch<SetStateAction<'idle' | 'copied' | 'failed'>>;
  setIsAuthPanelDismissed: Dispatch<SetStateAction<boolean>>;
  cleanupListeners: () => void;
  restoreOutputConsumerFromSnapshot: (
    consumer: RendererOutputConsumer | null | undefined,
  ) => Promise<boolean>;
  recoverTerminalSurface: (
    shouldFocus?: boolean,
    shouldScrollToBottom?: boolean,
  ) => void;
  scrollTerminalToBottom: (shouldFocus?: boolean, shouldRefresh?: boolean) => void;
  scheduleTerminalRefresh: () => void;
}

interface PtyConnectionController {
  detachCurrentPty: (options?: DetachCurrentPtyOptions) => void;
  connectToShell: () => void;
  restartShell: () => void;
  restartAfterExit: () => void;
  retryConnectNow: () => void;
}

export function usePtyConnectionController({
  paneId,
  rendererScope,
  isInitialized,
  t,
  terminalRef,
  fitAddonRef,
  ptyIdRef,
  unlistenOutputRef,
  unlistenExitRef,
  retryCountRef,
  reconnectTimeoutRef,
  manuallyDisconnectedRef,
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
}: UsePtyConnectionControllerOptions): PtyConnectionController {
  const setConnecting = useCallback((value: boolean) => {
    isConnectingRef.current = value;
    setIsConnecting(value);
  }, [isConnectingRef, setIsConnecting]);

  const setConnected = useCallback((value: boolean) => {
    isConnectedRef.current = value;
    setIsConnected(value);
  }, [isConnectedRef, setIsConnected]);

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
      if (terminalRef.current) {
        unregisterTerminal(ptyIdRef.current, terminalRef.current);
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

    if (clearTerminal && terminalRef.current) {
      terminalRef.current.clear();
      terminalRef.current.write('\x1b[2J\x1b[H');
    }

    setConnected(false);
    setConnecting(false);
    setAuthUrlCopyStatus('idle');
    setIsAuthPanelDismissed(false);
  }, [
    cleanupListeners,
    connectGenerationRef,
    exitedRef,
    lastPtySizeRef,
    pendingNewLinesRef,
    preservePtyOnUnmountRef,
    ptyIdRef,
    reconnectTimeoutRef,
    retryCountRef,
    scrolledUpRef,
    setAuthUrlCopyStatus,
    setConnectError,
    setConnected,
    setConnecting,
    setExitInfo,
    setIsAuthPanelDismissed,
    setNewOutputLines,
    setRetryAttempt,
    setScrolledUp,
    terminalRef,
  ]);

  const scheduleReconnect = useCallback((connectPty: () => void) => {
    if (manuallyDisconnectedRef.current) return;
    const delay = computeReconnectDelay(retryCountRef.current);
    retryCountRef.current += 1;
    setRetryAttempt(retryCountRef.current);
    reconnectTimeoutRef.current = setTimeout(() => {
      connectPty();
    }, delay);
  }, [
    manuallyDisconnectedRef,
    reconnectTimeoutRef,
    retryCountRef,
    setRetryAttempt,
  ]);

  // Flush the buffered "new lines while scrolled up" count into render state
  // at most every 200ms so a fast output burst doesn't re-render per chunk.
  const scheduleNewOutputFlush = useCallback(() => {
    if (newOutputFlushTimerRef.current) return;
    newOutputFlushTimerRef.current = setTimeout(() => {
      newOutputFlushTimerRef.current = null;
      setNewOutputLines(pendingNewLinesRef.current);
    }, 200);
  }, [
    newOutputFlushTimerRef,
    pendingNewLinesRef,
    setNewOutputLines,
  ]);

  const connectPty: () => void = useCallback(() => {
    if (isConnectingRef.current || isConnectedRef.current) return;
    const project = selectedProjectRef.current;
    if (!project || !terminalRef.current) return;

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
        if (isStaleSetup() || !terminalRef.current) return;

        cleanupListeners();

        const rows = terminalRef.current?.rows || 24;
        const cols = terminalRef.current?.cols || 120;
        const connectedPtyId = await pty.create(ptySessionId, projectPath, rows, cols);
        if (isStaleSetup() || !terminalRef.current) return;
        const consumerId = createRendererConsumerId(rendererScope);
        await pty.registerOutputConsumer(connectedPtyId, consumerId);
        if (isStaleSetup() || !terminalRef.current) {
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
        if (terminalRef.current && connectedPtyId) {
          registerTerminal(connectedPtyId, terminalRef.current);
        }

        const sequencer = createTerminalOutputPipeline({
          connectedPtyId,
          consumerId,
          outputAcknowledger,
          isStaleSetup,
          terminalRef,
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
            !terminalRef.current
          ) {
            return;
          }
          sequencer.receive({ seq, data });
        }));
        localUnlistenOutput = unlistenOut;
        if (isStaleSetup() || !terminalRef.current) {
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
          const term = terminalRef.current;
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
        if (isStaleSetup() || !terminalRef.current) {
          cleanupLocalSetup();
          return;
        }

        unlistenOutputRef.current = unlistenOut;
        unlistenExitRef.current = unlistenExit;

        try {
          const snapshot = await pty.attachSnapshot(connectedPtyId);
          if (isStaleSetup() || !terminalRef.current) {
            cleanupLocalSetup();
            return;
          }
          if (snapshot) {
            if (terminalRef.current) {
              terminalRef.current.clear();
              terminalRef.current.write('\x1b[2J\x1b[H');
              if (snapshot.rows && snapshot.cols) {
                terminalRef.current.resize(snapshot.cols, snapshot.rows);
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
          if (isStaleSetup() || !terminalRef.current) {
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
    activeRef,
    autoReconnectOnExitRef,
    cleanupListeners,
    connectGenerationRef,
    desiredPaneIdRef,
    exitedRef,
    initialCommandRef,
    isConnectedRef,
    isConnectingRef,
    lastPtySizeRef,
    onInitialCommandSentRef,
    outputConsumerRef,
    outputSequencerRef,
    paneId,
    pendingNewLinesRef,
    ptyIdRef,
    reconnectTimeoutRef,
    recoverTerminalSurface,
    rendererScope,
    restoreOutputConsumerFromSnapshot,
    retryCountRef,
    scheduleNewOutputFlush,
    scheduleReconnect,
    scheduleTerminalRefresh,
    scrollTerminalToBottom,
    scrolledUpRef,
    selectedProjectRef,
    setConnectError,
    setConnected,
    setConnecting,
    setExitInfo,
    setRetryAttempt,
    setScrolledUp,
    suppressInitialCommandWhenPtyExistsRef,
    t,
    terminalRef,
    unlistenExitRef,
    unlistenOutputRef,
  ]);

  const connectToShell = useCallback(() => {
    if (!isInitialized || isConnectedRef.current || isConnectingRef.current) return;
    manuallyDisconnectedRef.current = false;
    connectPty();
  }, [
    connectPty,
    isConnectedRef,
    isConnectingRef,
    isInitialized,
    manuallyDisconnectedRef,
  ]);

  const disconnectFromShell = useCallback(() => {
    manuallyDisconnectedRef.current = true;
    detachCurrentPty({ clearTerminal: true, kill: true });
  }, [detachCurrentPty, manuallyDisconnectedRef]);

  const restartShell = useCallback(() => {
    setIsRestarting(true);
    disconnectFromShell();
    manuallyDisconnectedRef.current = false;

    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    }

    setIsInitialized(false);
    setTimeout(() => {
      setIsRestarting(false);
    }, 200);
  }, [
    disconnectFromShell,
    fitAddonRef,
    manuallyDisconnectedRef,
    setIsInitialized,
    setIsRestarting,
    terminalRef,
  ]);

  // Audit P1-2: explicit user restart after the session exited. This is the
  // only path (besides a fresh ptyId from auto-restart) that clears the
  // screen — the user has read the exit banner and asked for a new session.
  const restartAfterExit = useCallback(() => {
    exitedRef.current = false;
    setExitInfo(null);
    retryCountRef.current = 0;
    setRetryAttempt(0);
    setConnectError(null);
    manuallyDisconnectedRef.current = false;
    const term = terminalRef.current;
    if (term) {
      term.clear();
      term.write('\x1b[2J\x1b[H');
    }
    connectToShell();
  }, [
    connectToShell,
    exitedRef,
    manuallyDisconnectedRef,
    retryCountRef,
    setConnectError,
    setExitInfo,
    setRetryAttempt,
    terminalRef,
  ]);

  // Audit P1-4: skip the backoff wait and reconnect immediately.
  const retryConnectNow = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    retryCountRef.current = 0;
    setRetryAttempt(0);
    manuallyDisconnectedRef.current = false;
    connectPty();
  }, [
    connectPty,
    manuallyDisconnectedRef,
    reconnectTimeoutRef,
    retryCountRef,
    setRetryAttempt,
  ]);

  return {
    detachCurrentPty,
    connectToShell,
    restartShell,
    restartAfterExit,
    retryConnectNow,
  };
}

interface UsePtyConnectionLifecycleOptions {
  paneId?: string;
  autoConnect: boolean;
  isInitialized: boolean;
  isConnecting: boolean;
  isConnected: boolean;
  ptyIdRef: MutableRefObject<string | null>;
  isConnectingRef: MutableRefObject<boolean>;
  isConnectedRef: MutableRefObject<boolean>;
  manuallyDisconnectedRef: MutableRefObject<boolean>;
  exitedRef: MutableRefObject<boolean>;
  reconnectTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  retryCountRef: MutableRefObject<number>;
  setExitInfo: Dispatch<SetStateAction<ShellExitInfo | null>>;
  setRetryAttempt: Dispatch<SetStateAction<number>>;
  setConnectError: Dispatch<SetStateAction<string | null>>;
  detachCurrentPty: (options?: DetachCurrentPtyOptions) => void;
  connectToShell: () => void;
}

export function usePtyConnectionLifecycle({
  paneId,
  autoConnect,
  isInitialized,
  isConnecting,
  isConnected,
  ptyIdRef,
  isConnectingRef,
  isConnectedRef,
  manuallyDisconnectedRef,
  exitedRef,
  reconnectTimeoutRef,
  retryCountRef,
  setExitInfo,
  setRetryAttempt,
  setConnectError,
  detachCurrentPty,
  connectToShell,
}: UsePtyConnectionLifecycleOptions): void {
  // A fresh ptyId (auto-restart feature, or a different card reusing this
  // Shell) clears the exit gate so the autoConnect effect below may run.
  // Defined BEFORE the autoConnect effect — same-commit effect order matters.
  useEffect(() => {
    exitedRef.current = false;
    setExitInfo(null);
    retryCountRef.current = 0;
    setRetryAttempt(0);
    setConnectError(null);
  }, [
    exitedRef,
    paneId,
    retryCountRef,
    setConnectError,
    setExitInfo,
    setRetryAttempt,
  ]);

  useEffect(() => {
    if (!isInitialized || !paneId) return;
    if (ptyIdRef.current === paneId) return;
    if (!ptyIdRef.current && !isConnectingRef.current && !isConnectedRef.current) return;

    manuallyDisconnectedRef.current = false;
    detachCurrentPty({ clearTerminal: true, kill: false });
  }, [
    detachCurrentPty,
    isConnectedRef,
    isConnectingRef,
    isInitialized,
    manuallyDisconnectedRef,
    paneId,
    ptyIdRef,
  ]);

  useEffect(() => {
    if (!autoConnect || !isInitialized) return;
    if (isConnectingRef.current || isConnectedRef.current) return;
    if (manuallyDisconnectedRef.current) return;
    // Audit P1-2: after a PTY exit the session stays down (banner + restart
    // strip) instead of silently respawning with a cleared screen.
    if (exitedRef.current) return;
    // A failed connect already scheduled a backoff retry; re-triggering here
    // would bypass the backoff and spin connect→fail→connect synchronously.
    if (reconnectTimeoutRef.current) return;
    connectToShell();
  }, [
    autoConnect,
    connectToShell,
    exitedRef,
    isConnected,
    isConnectedRef,
    isConnecting,
    isConnectingRef,
    isInitialized,
    manuallyDisconnectedRef,
    reconnectTimeoutRef,
  ]);
}
