import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { Terminal } from '@xterm/xterm';
import { logger } from '../../lib/logger';
import { pty } from '../../lib/tauri-bridge';
import type {
  OutputSequencer,
  RendererOutputConsumer,
  TerminalSize,
  Unlisten,
} from './shellRuntimeTypes';

export const RENDERER_CONSUMER_HEARTBEAT_MS = 5000;

export function createRendererConsumerId(scope = 'main'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  const instanceId = uuid || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `renderer:${scope}:${instanceId}`;
}

export function onceUnlisten(unlisten: Unlisten | null | undefined): Unlisten {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unlisten?.();
  };
}

export function disposeRendererConsumer(
  consumer: RendererOutputConsumer | null | undefined,
): void {
  if (!consumer || consumer.disposed) return;
  consumer.disposed = true;
  if (consumer.heartbeatTimer !== null) {
    window.clearInterval(consumer.heartbeatTimer);
  }
  consumer.acknowledger.dispose();
  // Best-effort immediate cleanup. The backend also expires renderer leases
  // that stop heartbeating, so a crashed WebView cannot pin flow forever.
  pty.unregisterOutputConsumer(consumer.ptyId, consumer.consumerId).catch(() => {});
}

interface UsePtyOutputLifecycleOptions {
  terminalRef: MutableRefObject<Terminal | null>;
  ptyIdRef: MutableRefObject<string | null>;
  unlistenOutputRef: MutableRefObject<Unlisten | null>;
  unlistenExitRef: MutableRefObject<Unlisten | null>;
  outputSequencerRef: MutableRefObject<OutputSequencer | null>;
  outputConsumerRef: MutableRefObject<RendererOutputConsumer | null>;
  lastPtySizeRef: MutableRefObject<TerminalSize | null>;
  scrolledUpRef: MutableRefObject<boolean>;
  pendingNewLinesRef: MutableRefObject<number>;
  setScrolledUp: Dispatch<SetStateAction<boolean>>;
  setNewOutputLines: Dispatch<SetStateAction<number>>;
}

interface PtyOutputLifecycle {
  restoreOutputConsumerFromSnapshot: (
    consumer: RendererOutputConsumer | null | undefined,
  ) => Promise<boolean>;
  cleanupListeners: () => void;
}

export function usePtyOutputLifecycle({
  terminalRef,
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
}: UsePtyOutputLifecycleOptions): PtyOutputLifecycle {
  const restoreOutputConsumerFromSnapshot = useCallback((
    consumer: RendererOutputConsumer | null | undefined,
  ): Promise<boolean> => {
    if (!consumer || consumer.disposed) return Promise.resolve(false);
    if (consumer.recoveryPromise) return consumer.recoveryPromise;

    const sequencer = outputSequencerRef.current;
    const term = terminalRef.current;
    if (!sequencer || !term || outputConsumerRef.current !== consumer) {
      return Promise.resolve(false);
    }

    consumer.needsSnapshotRecovery = true;
    // Buffer live output until the attach snapshot establishes a fresh,
    // process-ordered watermark. This prevents a long-hidden WebView from
    // painting stale output over the recovered screen.
    sequencer.reset();

    const isCurrentRecovery = () =>
      !consumer.disposed &&
      outputConsumerRef.current === consumer &&
      outputSequencerRef.current === sequencer &&
      terminalRef.current === term &&
      ptyIdRef.current === consumer.ptyId;

    let registered = false;
    let recoveryPromise: Promise<boolean> | null = null;
    recoveryPromise = (async () => {
      try {
        await pty.registerOutputConsumer(consumer.ptyId, consumer.consumerId);
        registered = true;
        if (!isCurrentRecovery()) return false;

        const snapshot = await pty.attachSnapshot(consumer.ptyId);
        if (!isCurrentRecovery()) return false;
        if (!snapshot) {
          throw new Error('PTY session is unavailable during renderer recovery');
        }

        term.clear();
        term.write('\x1b[2J\x1b[H');
        if (snapshot.rows && snapshot.cols) {
          term.resize(snapshot.cols, snapshot.rows);
          lastPtySizeRef.current = { rows: snapshot.rows, cols: snapshot.cols };
        }
        sequencer.applySnapshot({
          seq: snapshot.seq,
          data: `${snapshot.history || ''}${snapshot.data || ''}`,
        });
        consumer.needsSnapshotRecovery = false;
        scrolledUpRef.current = false;
        pendingNewLinesRef.current = 0;
        setScrolledUp(false);
        setNewOutputLines(0);
        return true;
      } catch (error) {
        if (isCurrentRecovery()) {
          logger.warn('[Shell] Renderer snapshot recovery failed:', error);
        }
        return false;
      } finally {
        if (registered && consumer.needsSnapshotRecovery) {
          await pty
            .unregisterOutputConsumer(consumer.ptyId, consumer.consumerId)
            .catch(() => {});
        }
        if (consumer.recoveryPromise === recoveryPromise) {
          consumer.recoveryPromise = null;
        }
      }
    })();
    consumer.recoveryPromise = recoveryPromise;
    return recoveryPromise;
  }, [
    lastPtySizeRef,
    outputConsumerRef,
    outputSequencerRef,
    pendingNewLinesRef,
    ptyIdRef,
    scrolledUpRef,
    setNewOutputLines,
    setScrolledUp,
    terminalRef,
  ]);

  const cleanupListeners = useCallback(() => {
    unlistenOutputRef.current?.();
    unlistenExitRef.current?.();
    unlistenOutputRef.current = null;
    unlistenExitRef.current = null;
    outputSequencerRef.current?.reset();
    outputSequencerRef.current = null;
    const outputConsumer = outputConsumerRef.current;
    outputConsumerRef.current = null;
    disposeRendererConsumer(outputConsumer);
  }, [
    outputConsumerRef,
    outputSequencerRef,
    unlistenExitRef,
    unlistenOutputRef,
  ]);

  return {
    restoreOutputConsumerFromSnapshot,
    cleanupListeners,
  };
}
