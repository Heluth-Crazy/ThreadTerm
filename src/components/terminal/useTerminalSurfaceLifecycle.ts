import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { pty } from '../../lib/tauri-bridge';
import { claimTerminalActive } from './xtermRegistry';
import {
  TERMINAL_GEOMETRY_INVALIDATED_EVENT,
  TERMINAL_SURFACE_SHOWN_EVENT,
} from './terminalSurfaceEvents';
import type { RendererOutputConsumer, TerminalSize } from './shellRuntimeTypes';

const RENDERER_CONSUMER_TTL_MS = 30000;

interface UseTerminalSurfaceControllerOptions {
  active: boolean;
  activeRef: MutableRefObject<boolean>;
  terminalHostRef: MutableRefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  ptyIdRef: MutableRefObject<string | null>;
  lastPtySizeRef: MutableRefObject<TerminalSize | null>;
  scrolledUpRef: MutableRefObject<boolean>;
  pendingNewLinesRef: MutableRefObject<number>;
  setScrolledUp: Dispatch<SetStateAction<boolean>>;
  setNewOutputLines: Dispatch<SetStateAction<number>>;
}

export interface TerminalSurfaceController {
  resizePtyIfNeeded: (rows: number, cols: number) => void;
  scrollTerminalToBottom: (shouldFocus?: boolean, shouldRefresh?: boolean) => void;
  cancelSurfaceRecovery: () => void;
  scheduleTerminalRefresh: () => void;
  recoverTerminalSurface: (shouldFocus?: boolean, shouldScrollToBottom?: boolean) => void;
  scrollToBottomNow: () => void;
  focusTerminal: () => void;
}

export function useTerminalSurfaceController({
  active,
  activeRef,
  terminalHostRef,
  terminalRef,
  fitAddonRef,
  ptyIdRef,
  lastPtySizeRef,
  scrolledUpRef,
  pendingNewLinesRef,
  setScrolledUp,
  setNewOutputLines,
}: UseTerminalSurfaceControllerOptions): TerminalSurfaceController {
  const surfaceRecoveryTimersRef = useRef<number[]>([]);
  const surfaceRecoveryFrameRef = useRef<number | null>(null);
  const surfaceRecoveryGenerationRef = useRef(0);
  const terminalRefreshFrameRef = useRef<number | null>(null);

  const resizePtyIfNeeded = useCallback((rows: number, cols: number) => {
    const id = ptyIdRef.current;
    if (!id || !rows || !cols) return;

    const last = lastPtySizeRef.current;
    if (last && last.rows === rows && last.cols === cols) return;

    lastPtySizeRef.current = { rows, cols };
    pty.resize(id, rows, cols).catch(() => {});
  }, [lastPtySizeRef, ptyIdRef]);

  const scrollTerminalToBottom = useCallback((
    shouldFocus = false,
    shouldRefresh = true,
  ) => {
    const term = terminalRef.current;
    if (!term) return;

    try {
      term.scrollToBottom();
    } catch {
      return;
    }

    scrolledUpRef.current = false;
    pendingNewLinesRef.current = 0;
    setScrolledUp(false);
    setNewOutputLines(0);

    if (shouldRefresh) {
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        // Best-effort repaint after programmatic scroll recovery.
      }
    }

    if (shouldFocus) {
      try {
        term.focus();
      } catch {
        // Focus can fail while the webview is backgrounded.
      }
    }
  }, [
    pendingNewLinesRef,
    scrolledUpRef,
    setNewOutputLines,
    setScrolledUp,
    terminalRef,
  ]);

  const clearSurfaceRecoveryWork = useCallback(() => {
    if (surfaceRecoveryFrameRef.current !== null) {
      cancelAnimationFrame(surfaceRecoveryFrameRef.current);
      surfaceRecoveryFrameRef.current = null;
    }
    for (const timer of surfaceRecoveryTimersRef.current) clearTimeout(timer);
    surfaceRecoveryTimersRef.current = [];
  }, []);

  const cancelSurfaceRecovery = useCallback(() => {
    surfaceRecoveryGenerationRef.current += 1;
    clearSurfaceRecoveryWork();
    if (terminalRefreshFrameRef.current !== null) {
      cancelAnimationFrame(terminalRefreshFrameRef.current);
      terminalRefreshFrameRef.current = null;
    }
  }, [clearSurfaceRecoveryWork]);

  const scheduleTerminalRefresh = useCallback(() => {
    if (!activeRef.current || terminalRefreshFrameRef.current !== null) return;
    terminalRefreshFrameRef.current = requestAnimationFrame(() => {
      terminalRefreshFrameRef.current = null;
      if (!activeRef.current) return;
      const term = terminalRef.current;
      if (!term) return;
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        // Renderer recovery is best-effort.
      }
    });
  }, [activeRef, terminalRef]);

  const recoverTerminalSurface = useCallback((
    shouldFocus = false,
    shouldScrollToBottom = false,
  ) => {
    if (!activeRef.current) return;

    clearSurfaceRecoveryWork();
    const generation = surfaceRecoveryGenerationRef.current + 1;
    surfaceRecoveryGenerationRef.current = generation;
    let geometrySettled = false;

    const run = () => {
      if (
        surfaceRecoveryGenerationRef.current !== generation ||
        !activeRef.current
      ) {
        return;
      }
      const term = terminalRef.current;
      const fit = fitAddonRef.current;
      const host = terminalHostRef.current;
      if (!term || !fit || !host) return;

      if (!geometrySettled) {
        const rect = host.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) return;

        try {
          fit.fit();
        } catch {
          // xterm fit can throw while a hidden webview is becoming visible.
          return;
        }

        resizePtyIfNeeded(term.rows, term.cols);
        geometrySettled = true;

        if (shouldScrollToBottom && !term.hasSelection()) {
          // This helper also synchronizes the React scroll indicator and
          // repaints after the programmatic scroll.
          scrollTerminalToBottom(false, true);
        } else {
          try {
            term.refresh(0, Math.max(0, term.rows - 1));
          } catch {
            // Best-effort renderer recovery.
          }
        }

        // Geometry/scroll work is complete after the first valid fit. Keep
        // the bounded late callbacks only when focus may need a later retry.
        if (!shouldFocus) {
          for (const timer of surfaceRecoveryTimersRef.current) clearTimeout(timer);
          surfaceRecoveryTimersRef.current = [];
        }
      }

      if (shouldFocus) {
        try {
          term.focus();
        } catch {
          // Focus can fail before the webview becomes key; later passes retry.
        }
      }
    };

    surfaceRecoveryFrameRef.current = requestAnimationFrame(() => {
      surfaceRecoveryFrameRef.current = null;
      run();
    });
    // Windows WebView2 reports a 0-sized host on the first frames after the
    // webview becomes visible, so the early passes hit the `rect.width < 20`
    // guard and `fit()` is skipped — the terminal stays at its default
    // cols/rows and never fills the pane. `run()` is idempotent, so the extra
    // late passes simply succeed once the surface has a real size.
    for (const delay of [60, 180, 400, 800]) {
      const timer = window.setTimeout(() => {
        surfaceRecoveryTimersRef.current =
          surfaceRecoveryTimersRef.current.filter((id) => id !== timer);
        run();
      }, delay);
      surfaceRecoveryTimersRef.current.push(timer);
    }
  }, [
    activeRef,
    clearSurfaceRecoveryWork,
    fitAddonRef,
    resizePtyIfNeeded,
    scrollTerminalToBottom,
    terminalHostRef,
    terminalRef,
  ]);

  const scrollToBottomNow = useCallback(() => {
    scrollTerminalToBottom(true);
  }, [scrollTerminalToBottom]);

  const focusTerminal = useCallback(() => {
    try {
      terminalRef.current?.focus();
    } catch {
      // Full surface recovery still runs from visibility/geometry lifecycle
      // events when a background WebView becomes usable again.
    }
  }, [terminalRef]);

  useEffect(() => {
    if (!active) {
      cancelSurfaceRecovery();
    }
  }, [active, cancelSurfaceRecovery]);

  return {
    resizePtyIfNeeded,
    scrollTerminalToBottom,
    cancelSurfaceRecovery,
    scheduleTerminalRefresh,
    recoverTerminalSurface,
    scrollToBottomNow,
    focusTerminal,
  };
}

interface UseTerminalSurfaceLifecycleOptions {
  active: boolean;
  isInitialized: boolean;
  isConnected: boolean;
  terminalRef: MutableRefObject<Terminal | null>;
  ptyIdRef: MutableRefObject<string | null>;
  lastPtySizeRef: MutableRefObject<TerminalSize | null>;
  outputConsumerRef: MutableRefObject<RendererOutputConsumer | null>;
  recoverTerminalSurface: (
    shouldFocus?: boolean,
    shouldScrollToBottom?: boolean,
  ) => void;
  restoreOutputConsumerFromSnapshot: (
    consumer: RendererOutputConsumer | null | undefined,
  ) => Promise<boolean>;
}

export function useTerminalSurfaceLifecycle({
  active,
  isInitialized,
  isConnected,
  terminalRef,
  ptyIdRef,
  lastPtySizeRef,
  outputConsumerRef,
  recoverTerminalSurface,
  restoreOutputConsumerFromSnapshot,
}: UseTerminalSurfaceLifecycleOptions): void {
  const documentHiddenAtRef = useRef<number | null>(
    typeof document !== 'undefined' && document.visibilityState !== 'visible'
      ? Date.now()
      : null,
  );

  useEffect(() => {
    if (!active || !isInitialized) return;
    recoverTerminalSurface(true, true);
  }, [active, isInitialized, recoverTerminalSurface]);

  useEffect(() => {
    if (!active || !isConnected || !ptyIdRef.current || !terminalRef.current) return;
    const consumer = outputConsumerRef.current;
    if (
      consumer &&
      !consumer.disposed &&
      document.visibilityState === 'visible'
    ) {
      // The backend removes float-scoped consumers before destroying an idle
      // WebView. Restore its lease immediately when it becomes active again.
      if (consumer.needsSnapshotRecovery) {
        void restoreOutputConsumerFromSnapshot(consumer);
      } else {
        void pty
          .registerOutputConsumer(consumer.ptyId, consumer.consumerId)
          .catch(() => {});
      }
    }
    claimTerminalActive(ptyIdRef.current, terminalRef.current);
  }, [
    active,
    isConnected,
    outputConsumerRef,
    ptyIdRef,
    restoreOutputConsumerFromSnapshot,
    terminalRef,
  ]);

  useEffect(() => {
    const handleSurfaceShown = (event: Event) => {
      const shouldFocus = !(event instanceof CustomEvent && event.detail?.focus === false);
      recoverTerminalSurface(shouldFocus);
    };
    const handleGeometryInvalidated = (event: Event) => {
      const targetPtyId = event instanceof CustomEvent ? event.detail?.ptyId : undefined;
      if (!targetPtyId || targetPtyId === ptyIdRef.current) {
        // Another WebView may have resized this shared ConPTY while our local
        // xterm dimensions stayed unchanged. Clear only the local dedupe cache
        // so the next surface recovery reasserts this renderer's geometry once.
        lastPtySizeRef.current = null;
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        documentHiddenAtRef.current ??= Date.now();
        return;
      }

      const hiddenAt = documentHiddenAtRef.current;
      documentHiddenAtRef.current = null;
      const consumer = outputConsumerRef.current;
      const requiresSnapshot =
        hiddenAt !== null && Date.now() - hiddenAt >= RENDERER_CONSUMER_TTL_MS;

      if (consumer && !consumer.disposed) {
        if (requiresSnapshot) {
          consumer.needsSnapshotRecovery = true;
          void restoreOutputConsumerFromSnapshot(consumer).then((restored) => {
            if (restored) recoverTerminalSurface(true, true);
          });
        } else {
          void pty
            .registerOutputConsumer(consumer.ptyId, consumer.consumerId)
            .catch(() => {});
        }
      }
      recoverTerminalSurface(true);
    };

    window.addEventListener('focus', handleSurfaceShown);
    window.addEventListener(TERMINAL_SURFACE_SHOWN_EVENT, handleSurfaceShown);
    window.addEventListener(TERMINAL_GEOMETRY_INVALIDATED_EVENT, handleGeometryInvalidated);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', handleSurfaceShown);
      window.removeEventListener(TERMINAL_SURFACE_SHOWN_EVENT, handleSurfaceShown);
      window.removeEventListener(TERMINAL_GEOMETRY_INVALIDATED_EVENT, handleGeometryInvalidated);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    lastPtySizeRef,
    outputConsumerRef,
    ptyIdRef,
    recoverTerminalSurface,
    restoreOutputConsumerFromSnapshot,
  ]);
}
