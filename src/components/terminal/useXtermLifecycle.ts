import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { pty } from '../../lib/tauri-bridge';
import { unregisterTerminal } from './xtermRegistry';
import { CODEX_DEVICE_AUTH_URL, isCodexLoginCommand } from './shellAuth';
import type {
  RendererOutputConsumer,
  ShellProject,
  TerminalSize,
} from './shellRuntimeTypes';

async function waitForFonts(): Promise<void> {
  if (!document.fonts?.ready) return;
  try {
    await document.fonts.ready;
  } catch {
    // Font readiness failure should not block terminal startup.
  }
}

interface UseXtermLifecycleOptions {
  selectedProjectRef: MutableRefObject<ShellProject | null | undefined>;
  projectPath?: string;
  projectFullPath?: string;
  isRestarting: boolean;
  minimal: boolean;
  terminalHostRef: MutableRefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  terminalThemeRef: MutableRefObject<ITheme>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  ptyIdRef: MutableRefObject<string | null>;
  initialCommandRef: MutableRefObject<string | undefined>;
  onUserSubmitRef: MutableRefObject<(() => void) | undefined>;
  activeRef: MutableRefObject<boolean>;
  preservePtyOnUnmountRef: MutableRefObject<boolean>;
  connectGenerationRef: MutableRefObject<number>;
  reconnectTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  retryCountRef: MutableRefObject<number>;
  newOutputFlushTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  pendingNewLinesRef: MutableRefObject<number>;
  scrolledUpRef: MutableRefObject<boolean>;
  lastPtySizeRef: MutableRefObject<TerminalSize | null>;
  setScrolledUp: Dispatch<SetStateAction<boolean>>;
  setNewOutputLines: Dispatch<SetStateAction<number>>;
  setIsInitialized: Dispatch<SetStateAction<boolean>>;
  copyAuthUrlToClipboard: (url: string) => Promise<boolean>;
  cleanupListeners: () => void;
  cancelSurfaceRecovery: () => void;
  recoverTerminalSurface: (
    shouldFocus?: boolean,
    shouldScrollToBottom?: boolean,
  ) => void;
  resizePtyIfNeeded: (rows: number, cols: number) => void;
  scheduleTerminalRefresh: () => void;
  scrollTerminalToBottom: (shouldFocus?: boolean, shouldRefresh?: boolean) => void;
  restoreOutputConsumerFromSnapshot: (
    consumer: RendererOutputConsumer | null | undefined,
  ) => Promise<boolean>;
}

export function useXtermLifecycle({
  selectedProjectRef,
  projectPath,
  projectFullPath,
  isRestarting,
  minimal,
  terminalHostRef,
  terminalRef,
  terminalThemeRef,
  fitAddonRef,
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
}: UseXtermLifecycleOptions): void {
  useEffect(() => {
    if (
      !terminalHostRef.current ||
      !selectedProjectRef.current ||
      isRestarting ||
      terminalRef.current
    ) {
      return;
    }

    terminalRef.current = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      allowProposedApi: true,
      allowTransparency: false,
      convertEol: true,
      scrollback: 3000,
      // Preserve ED2 semantics without turning a full-screen TUI repaint into
      // scrollback movement. Agent control sequences remain byte-identical.
      scrollOnEraseInDisplay: false,
      tabStopWidth: 4,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      theme: terminalThemeRef.current,
    });

    fitAddonRef.current = new FitAddon();
    terminalRef.current.loadAddon(fitAddonRef.current);
    if (!minimal) {
      terminalRef.current.loadAddon(new WebLinksAddon());
    }

    terminalRef.current.open(terminalHostRef.current);

    // Windows WebView2's xterm DOM renderer is extremely slow with a large
    // scrollback. Activate the GPU renderer and degrade gracefully when WebGL
    // is unavailable or its context is lost.
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        try {
          webglAddon.dispose();
        } catch {
          // Already disposed — xterm falls back to the DOM renderer.
        }
      });
      terminalRef.current.loadAddon(webglAddon);
    } catch {
      // WebGL unsupported in this webview — keep xterm's DOM renderer.
    }

    terminalRef.current.attachCustomKeyEventHandler((event) => {
      const activeAuthUrl = isCodexLoginCommand(initialCommandRef.current)
        ? CODEX_DEVICE_AUTH_URL
        : '';

      if (
        event.type === 'keydown' &&
        minimal &&
        activeAuthUrl &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key?.toLowerCase() === 'c'
      ) {
        copyAuthUrlToClipboard(activeAuthUrl).catch(() => {});
      }

      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key?.toLowerCase() === 'c' &&
        terminalRef.current?.hasSelection()
      ) {
        event.preventDefault();
        event.stopPropagation();
        document.execCommand('copy');
        return false;
      }

      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key?.toLowerCase() === 'v'
      ) {
        event.preventDefault();
        event.stopPropagation();

        navigator.clipboard
          .readText()
          .then((text) => {
            if (ptyIdRef.current) {
              pty.input(ptyIdRef.current, text).catch(() => {});
              if (/[\r\n]/.test(text)) {
                onUserSubmitRef.current?.();
              }
            }
          })
          .catch(() => {});
        return false;
      }

      return true;
    });

    terminalRef.current.onData((data) => {
      if (ptyIdRef.current) {
        pty.input(ptyIdRef.current, data).catch(() => {});
        if (/[\r\n]/.test(data)) {
          onUserSubmitRef.current?.();
        }
      }
    });

    // Track whether the viewport sits at the bottom; returning to the bottom
    // clears the new-output counter.
    const scrollDisposable = terminalRef.current.onScroll(() => {
      if (!activeRef.current) return;
      const term = terminalRef.current;
      if (!term) return;
      const buf = term.buffer.active;
      const atBottom = buf.type === 'alternate' || buf.viewportY >= buf.baseY;
      scrolledUpRef.current = !atBottom;
      setScrolledUp(!atBottom);
      if (atBottom) {
        pendingNewLinesRef.current = 0;
        setNewOutputLines(0);
      }
    });

    waitForFonts().finally(() => {
      requestAnimationFrame(() => {
        recoverTerminalSurface(activeRef.current, true);
      });
    });

    setIsInitialized(true);

    let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (!fitAddonRef.current || !terminalRef.current) return;
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = setTimeout(() => {
        resizeDebounceTimer = null;
        if (!fitAddonRef.current || !terminalRef.current) return;
        // Hidden terminals skip fit entirely. Fitting while hidden resizes
        // ConPTY and replays the screen; recovery re-fits when visible again.
        const host = terminalHostRef.current;
        if (host && getComputedStyle(host).visibility === 'hidden') return;
        try {
          fitAddonRef.current.fit();
        } catch {
          return;
        }
        resizePtyIfNeeded(terminalRef.current.rows, terminalRef.current.cols);
        if (
          activeRef.current &&
          !scrolledUpRef.current &&
          !terminalRef.current.hasSelection()
        ) {
          scrollTerminalToBottom();
        }
      }, 150);
    });

    resizeObserver.observe(terminalHostRef.current);

    return () => {
      connectGenerationRef.current += 1;
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      resizeObserver.disconnect();
      try {
        scrollDisposable.dispose();
      } catch {
        // Already disposed with the terminal.
      }
      if (newOutputFlushTimerRef.current) {
        clearTimeout(newOutputFlushTimerRef.current);
        newOutputFlushTimerRef.current = null;
      }
      pendingNewLinesRef.current = 0;
      scrolledUpRef.current = false;
      cancelSurfaceRecovery();

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      retryCountRef.current = 0;
      cleanupListeners();

      if (ptyIdRef.current) {
        if (terminalRef.current) {
          unregisterTerminal(ptyIdRef.current, terminalRef.current);
        } else {
          unregisterTerminal(ptyIdRef.current);
        }
        if (!preservePtyOnUnmountRef.current) {
          pty.kill(ptyIdRef.current).catch(() => {});
        }
      }
      ptyIdRef.current = null;
      lastPtySizeRef.current = null;

      if (terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
      fitAddonRef.current = null;
    };
  }, [
    activeRef,
    cancelSurfaceRecovery,
    cleanupListeners,
    connectGenerationRef,
    copyAuthUrlToClipboard,
    fitAddonRef,
    initialCommandRef,
    isRestarting,
    lastPtySizeRef,
    minimal,
    newOutputFlushTimerRef,
    onUserSubmitRef,
    pendingNewLinesRef,
    preservePtyOnUnmountRef,
    projectFullPath,
    projectPath,
    ptyIdRef,
    reconnectTimeoutRef,
    recoverTerminalSurface,
    resizePtyIfNeeded,
    restoreOutputConsumerFromSnapshot,
    retryCountRef,
    scheduleTerminalRefresh,
    scrollTerminalToBottom,
    scrolledUpRef,
    selectedProjectRef,
    setIsInitialized,
    setNewOutputLines,
    setScrolledUp,
    terminalHostRef,
    terminalRef,
    terminalThemeRef,
  ]);
}
