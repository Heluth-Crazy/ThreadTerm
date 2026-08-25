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
import { isTauriEnv, pty, type PtyLaunchDescriptor } from '../../lib/tauri-bridge';
import type { PtyProviderStartupIntent } from '../../types/ptyStartup';
import { createTerminalLaunchTrace } from '../../lib/terminalLaunchDiagnostics';
import { createOutputAcknowledger } from './outputAcknowledger';
import { computeReconnectDelay, formatExitBanner } from './shellBehavior';
import { createTerminalOutputPipeline } from './terminalOutputPipeline';
import { createPtyStartupReconciliation } from './ptyStartupReconciliation';
import {
  createRendererConsumerId,
  disposeRendererConsumer,
  onceUnlisten,
  RENDERER_CONSUMER_HEARTBEAT_MS,
} from './usePtyOutputLifecycle';
import { registerTerminal, unregisterTerminal } from './xtermRegistry';
import type { ResumeLoadingProgressObserver } from './resumeLoadingProgressTypes';
import type {
  DetachCurrentPtyOptions,
  OutputSequencer,
  RendererOutputConsumer,
  ShellExitInfo,
  ShellProject,
  TerminalSize,
  Unlisten,
} from './shellRuntimeTypes';
import type { OneShotRunState, TerminalExecutionMode } from '../../types/terminal';

interface UsePtyConnectionControllerOptions {
  paneId?: string;
  terminalType?: string;
  rendererScope: string;
  isInitialized: boolean;
  t: TFunction<'terminal'>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  ptyIdRef: MutableRefObject<string | null>;
  unlistenOutputRef: MutableRefObject<Unlisten | null>;
  unlistenExitRef: MutableRefObject<Unlisten | null>;
  unlistenStartupRef: MutableRefObject<Unlisten | null>;
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
  providerStartupRef: MutableRefObject<PtyProviderStartupIntent | undefined>;
  executionModeRef: MutableRefObject<TerminalExecutionMode | undefined>;
  oneShotRunStateRef: MutableRefObject<OneShotRunState | undefined>;
  onOneShotRunStartedRef: MutableRefObject<(() => void) | undefined>;
  onOneShotRunInterruptedRef: MutableRefObject<(() => void) | undefined>;
  activeRef: MutableRefObject<boolean>;
  preservePtyOnUnmountRef: MutableRefObject<boolean>;
  autoReconnectOnExitRef: MutableRefObject<boolean>;
  suppressInitialCommandWhenPtyExistsRef: MutableRefObject<boolean>;
  resumeLoadingObserverRef?: MutableRefObject<ResumeLoadingProgressObserver | null>;
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
  terminalType,
  rendererScope,
  isInitialized,
  t,
  terminalRef,
  fitAddonRef,
  ptyIdRef,
  unlistenOutputRef,
  unlistenExitRef,
  unlistenStartupRef,
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
  providerStartupRef,
  executionModeRef,
  oneShotRunStateRef,
  onOneShotRunStartedRef,
  onOneShotRunInterruptedRef,
  activeRef,
  preservePtyOnUnmountRef,
  autoReconnectOnExitRef,
  suppressInitialCommandWhenPtyExistsRef,
  resumeLoadingObserverRef,
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
    if (
      executionModeRef.current === 'oneShot' &&
      oneShotRunStateRef.current !== 'queued' &&
      oneShotRunStateRef.current !== 'running'
    ) {
      // A terminal one-shot generation is a durable final state. Reopening
      // the card or rehydrating the store must never execute it again.
      return;
    }

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
      let localUnlistenLaunch: Unlisten | null = null;
      let localUnlistenStartup: Unlisten | null = null;
      let localSequencer: OutputSequencer | null = null;
      let localOutputConsumer: RendererOutputConsumer | null = null;
      let launchTrace: ReturnType<typeof createTerminalLaunchTrace> | null = null;
      let startupListenerAvailable = false;
      const startupReconciliation = createPtyStartupReconciliation();
      const cleanupStartup = onceUnlisten(() => {
        localUnlistenStartup?.();
        startupReconciliation.dispose();
      });
      let firstPaintScheduled = false;
      const cleanupLocalSetup = () => {
        localUnlistenOutput?.();
        localUnlistenExit?.();
        localUnlistenLaunch?.();
        cleanupStartup();
        localSequencer?.reset();
        disposeRendererConsumer(localOutputConsumer);

        if (unlistenOutputRef.current === localUnlistenOutput) {
          unlistenOutputRef.current = null;
        }
        if (unlistenExitRef.current === localUnlistenExit) {
          unlistenExitRef.current = null;
        }
        if (unlistenStartupRef.current === cleanupStartup) {
          unlistenStartupRef.current = null;
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
        const isStaleSetup = () =>
          connectGenerationRef.current !== setupGeneration ||
          (paneId && desiredPaneIdRef.current !== paneId);
        launchTrace = createTerminalLaunchTrace({
          ptyId: ptySessionId,
          provider: terminalType,
        });
        launchTrace.mark('uiRequest');
        // `connectPty` runs only after the xterm lifecycle has opened the
        // terminal surface, so this mark brackets the first renderer attach.
        launchTrace.mark('xtermOpened');

        // The launch event is diagnostic-only. A missing/older bridge must
        // never make a terminal fail to open.
        if (typeof pty.onLaunchPhase === 'function') {
          try {
            localUnlistenLaunch = onceUnlisten(
              await pty.onLaunchPhase((payload) => {
                launchTrace?.acceptBackendPhase(payload);
              }),
            );
          } catch {
            localUnlistenLaunch = null;
          }
        }
        // Functional startup observation is registered before a v2 create so
        // an immediate backend dispatch cannot race this WebView. Listener
        // failure is recoverable from the returned snapshot/query below.
        if (providerStartupRef.current) {
          try {
            localUnlistenStartup = onceUnlisten(await pty.onStartupState((snapshot) => {
              if (isStaleSetup()) return;
              const observed = startupReconciliation.acceptEvent(snapshot);
              if (observed.sent) {
                resumeLoadingObserverRef?.current?.commandDispatching();
              }
              if (observed.needsQuery) {
                void pty.getStartupState(snapshot.ptyId, snapshot.generation)
                  .then((current) => {
                    if (isStaleSetup()) return;
                    const recovered = startupReconciliation.acceptQuery(snapshot.generation, current);
                    if (recovered.sent) resumeLoadingObserverRef?.current?.commandDispatching();
                  })
                  .catch(() => {});
              }
            }));
            startupListenerAvailable = true;
          } catch {
            localUnlistenStartup = null;
          }
        }
        let sessionAlreadyExists = false;
        try {
          await pty.getSessionState(ptySessionId);
          sessionAlreadyExists = true;
        } catch {
          sessionAlreadyExists = false;
        }
        if (isStaleSetup() || !terminalRef.current) {
          cleanupLocalSetup();
          return;
        }
        if (
          sessionAlreadyExists &&
          suppressInitialCommandWhenPtyExistsRef.current
        ) {
          resumeLoadingObserverRef?.current?.skip();
        }

        cleanupListeners();

        const rows = terminalRef.current?.rows || 24;
        const cols = terminalRef.current?.cols || 120;
        const oneShotCommand =
          executionModeRef.current === 'oneShot'
            ? initialCommandRef.current?.trim()
            : undefined;
        const oneShotLaunch: PtyLaunchDescriptor | undefined = oneShotCommand
          ? { executionMode: 'oneShot', command: oneShotCommand }
          : undefined;
        if (oneShotLaunch && !sessionAlreadyExists) {
          onOneShotRunStartedRef.current?.();
        }
        let connectedPtyId: string;
        const providerStartup = providerStartupRef.current;
        if (providerStartup) {
          const created = await pty.createSessionV2({
            id: ptySessionId,
            workingDir: projectPath,
            rows,
            cols,
            launchAttemptId: launchTrace?.launchAttemptId,
            startup: providerStartup,
          });
          if (isStaleSetup() || !terminalRef.current) {
            cleanupLocalSetup();
            return;
          }
          connectedPtyId = created.ptyId;
          const observed = startupReconciliation.acceptCreate(created);
          if (created.disposition === 'attached') {
            resumeLoadingObserverRef?.current?.skip();
          } else if (observed.sent) {
            resumeLoadingObserverRef?.current?.commandDispatching();
          } else {
            resumeLoadingObserverRef?.current?.connectionReady();
          }
          if (!startupListenerAvailable || observed.needsQuery) {
            void pty.getStartupState(created.ptyId, created.generation)
              .then((snapshot) => {
                if (isStaleSetup()) return;
                const recovered = startupReconciliation.acceptQuery(created.generation, snapshot);
                if (recovered.sent) resumeLoadingObserverRef?.current?.commandDispatching();
              })
              .catch(() => {});
          }
        } else if (typeof pty.createWithLaunchAttempt === 'function' && launchTrace) {
          connectedPtyId = oneShotLaunch
            ? await pty.createWithLaunchAttempt(
                ptySessionId,
                projectPath,
                rows,
                cols,
                terminalType,
                launchTrace.launchAttemptId,
                oneShotLaunch,
              )
            : await pty.createWithLaunchAttempt(
                ptySessionId,
                projectPath,
                rows,
                cols,
                terminalType,
                launchTrace.launchAttemptId,
              );
        } else if (terminalType === undefined) {
          connectedPtyId = oneShotLaunch
            ? await pty.create(ptySessionId, projectPath, rows, cols, undefined, oneShotLaunch)
            : await pty.create(ptySessionId, projectPath, rows, cols);
        } else {
          connectedPtyId = oneShotLaunch
            ? await pty.create(
                ptySessionId,
                projectPath,
                rows,
                cols,
                terminalType,
                oneShotLaunch,
              )
            : await pty.create(ptySessionId, projectPath, rows, cols, terminalType);
        }
        launchTrace?.mark('ptyCreateReturned');
        if (isStaleSetup() || !terminalRef.current) {
          cleanupLocalSetup();
          return;
        }
        const consumerId = createRendererConsumerId(rendererScope);
        await pty.registerOutputConsumer(connectedPtyId, consumerId);
        if (isStaleSetup() || !terminalRef.current) {
          await pty.unregisterOutputConsumer(connectedPtyId, consumerId).catch(() => {});
          cleanupLocalSetup();
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
          onTerminalWriteStarted: () => {
            launchTrace?.mark('xtermWriteStarted');
          },
          onTerminalWriteCompleted: () => {
            launchTrace?.mark('xtermWriteCompleted');
            if (launchTrace?.has('firstPaint') || firstPaintScheduled) return;
            firstPaintScheduled = true;
            const markPaint = () => launchTrace?.mark('firstPaint');
            if (typeof queueMicrotask === 'function') {
              queueMicrotask(markPaint);
            } else {
              Promise.resolve().then(markPaint);
            }
          },
          resumeLoadingObserverRef,
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
          if (data) {
            launchTrace?.mark('firstRawByte');
            if (launchTrace?.has('startupCommandSent')) {
              launchTrace.mark('firstPostCommandByte');
            }
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
          resumeLoadingObserverRef?.current?.abort();
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
          if (autoReconnectOnExitRef.current && executionModeRef.current !== 'oneShot') {
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
        unlistenStartupRef.current = cleanupStartup;

        try {
          const snapshot = await pty.attachSnapshot(connectedPtyId);
          if (isStaleSetup() || !terminalRef.current) {
            cleanupLocalSetup();
            return;
          }
          if (snapshot) {
            const snapshotText = `${snapshot.history || ''}${snapshot.data || ''}`;
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

        const command = initialCommandRef.current;
        const shouldSendInitialCommand =
          !providerStartup &&
          executionModeRef.current !== 'oneShot' &&
          Boolean(command?.trim()) &&
          !(suppressInitialCommandWhenPtyExistsRef.current && sessionAlreadyExists);

        if (shouldSendInitialCommand && command !== undefined) {
          resumeLoadingObserverRef?.current?.connectionReady();
        } else {
          resumeLoadingObserverRef?.current?.skip();
        }

        setConnected(true);
        setConnecting(false);
        retryCountRef.current = 0;
        setRetryAttempt(0);
        setConnectError(null);
        recoverTerminalSurface(true, true);

        if (shouldSendInitialCommand) {
          resumeLoadingObserverRef?.current?.commandDispatching();
          await pty.input(connectedPtyId, `${command}\r`);
          if (isStaleSetup()) {
            cleanupLocalSetup();
            return;
          }
          launchTrace?.mark('startupCommandSent');
          launchTrace?.mark('connected');
        } else {
          launchTrace?.mark('connected');
        }
      } catch (error) {
        cleanupLocalSetup();
        if (connectGenerationRef.current !== setupGeneration) return;
        launchTrace?.mark('failed');
        resumeLoadingObserverRef?.current?.abort();
        logger.error('[Shell] PTY connection failed:', error);
        setConnectError(error instanceof Error ? error.message : String(error));
        setConnected(false);
        setConnecting(false);
        if (executionModeRef.current === 'oneShot') {
          // A launch failure is terminal for this generation. Persisting an
          // interrupted state lets the user choose Run again without an
          // automatic shell recreation loop.
          exitedRef.current = true;
          setExitInfo({ code: null });
          onOneShotRunInterruptedRef.current?.();
        } else {
          scheduleReconnect(connectPty);
        }
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
    executionModeRef,
    oneShotRunStateRef,
    isConnectedRef,
    isConnectingRef,
    lastPtySizeRef,
    onOneShotRunInterruptedRef,
    onOneShotRunStartedRef,
    outputConsumerRef,
    outputSequencerRef,
    paneId,
    pendingNewLinesRef,
    ptyIdRef,
    providerStartupRef,
    reconnectTimeoutRef,
    recoverTerminalSurface,
    rendererScope,
    restoreOutputConsumerFromSnapshot,
    retryCountRef,
    resumeLoadingObserverRef,
    scheduleNewOutputFlush,
    scheduleReconnect,
    scheduleTerminalRefresh,
    scrollTerminalToBottom,
    scrolledUpRef,
    selectedProjectRef,
    terminalType,
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
    unlistenStartupRef,
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
