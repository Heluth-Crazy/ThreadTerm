import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ServerMessage } from '@shared/mobile/bridge/protocol';

// P2 architecture: a single xterm instance drives both preview and detail
// surfaces. The bridge protocol contract is unchanged:
//   - terminal_snapshot = a wezterm full-screen serialization. It is a RESET
//     boundary: reset() then write(history + screen).
//   - terminal_output   = incremental data. It is an APPEND: write(data).
// The AnsiStreamClassifier / ChatBlock / TuiBlock path is intentionally no
// longer referenced here (kept on disk for rollback), so streaming AI CLI
// output is mirrored exactly like the desktop terminal without block chrome.
//
// Renderer: xterm's DEFAULT DOM renderer (no WebglAddon). The WebGL renderer
// was removed deliberately. iOS Tauri WKWebView can return a non-null
// `getContext('webgl2')` that never composites, so even a probe-gated WebGL
// addon left the canvas fully black with no DOM text fallback on real devices.
// The user goal is "faithfully mirror the desktop terminal content" — content
// visibility outranks scroll smoothness. The DOM renderer paints text into the
// DOM, is fully WKWebView-compatible, and scrolls fine for the bounded
// scrollback here. (`@xterm/addon-webgl` stays in package.json / the
// vendor-xterm chunk, just unreferenced, so WebGL can be revisited on a
// verifiable platform without churning the lockfile.)

interface MainTerminalProps {
  activeCardId: string | null;
  messages: ServerMessage[];
  mode?: 'detail' | 'preview';
  className?: string;
  // Optional bridge resize channel. App wires this to bridge.send for
  // full-control devices only; read-only / preview surfaces leave it undefined
  // so local fitting never issues a read-only resize command.
  onResize?: (cols: number, rows: number) => void;
}

// Forced dark palette. iOS WKWebView in system light mode otherwise paints the
// xterm canvas white (known regression). The desktop theme is intentionally not
// applied here — the mobile terminal stays a fixed dark surface.
const DARK_THEME = {
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(255,255,255,0.30)',
  black: '#000000',
  red: '#ff5f56',
  green: '#27c93f',
  yellow: '#ffbd2e',
  blue: '#57a5ff',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d0d0d0',
  brightBlack: '#5c6370',
  brightRed: '#ff7b72',
  brightGreen: '#3fdd5a',
  brightYellow: '#ffd479',
  brightBlue: '#79b8ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#7fdbe4',
  brightWhite: '#ffffff',
} as const;

const DETAIL_SCROLLBACK = 4000;
const PREVIEW_SCROLLBACK = 160;

function snapshotPayload(snapshot: {
  history?: string;
  data: string;
}): string {
  return [snapshot.history, snapshot.data].filter(Boolean).join('');
}

export function MainTerminal({
  activeCardId,
  messages,
  mode = 'detail',
  className = '',
  onResize,
}: MainTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Identity of the terminal_snapshot currently replayed into xterm. Reusing
  // the same snapshot must NOT re-reset (that would flash the screen on every
  // re-render). -1 means no snapshot has been applied to this card yet.
  const appliedSnapshotSeqRef = useRef<number>(-1);
  // Highest terminal_output seq already written. Snapshots reset this to their
  // own seq so post-snapshot output continues from the new epoch.
  const lastAppliedOutputSeqRef = useRef<number>(-1);
  const activeCardIdRef = useRef<string | null>(activeCardId);
  const onResizeRef = useRef<typeof onResize>(onResize);
  const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  onResizeRef.current = onResize;

  // Create the single xterm instance once. open(host) and dispose() happen
  // exactly once per mount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      convertEol: false,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: mode === 'preview' ? 11 : 13,
      lineHeight: 1.2,
      scrollback: mode === 'preview' ? PREVIEW_SCROLLBACK : DETAIL_SCROLLBACK,
      theme: { ...DARK_THEME },
    });
    terminalRef.current = terminal;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);

    terminal.open(host);

    // No WebGL addon: xterm uses its default DOM renderer (see header note).
    // Text is rendered into the DOM, which composites reliably in iOS
    // WKWebView and never leaves a black canvas.

    return () => {
      fitAddonRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      appliedSnapshotSeqRef.current = -1;
      lastAppliedOutputSeqRef.current = -1;
    };
    // mode only affects the initial font size; remount on mode change is fine
    // and avoids reconfiguring a live terminal.
  }, [mode]);

  // Reset epoch tracking when the active card changes so the next snapshot is
  // treated as a fresh reset boundary for the new card.
  useEffect(() => {
    if (activeCardIdRef.current === activeCardId) return;
    activeCardIdRef.current = activeCardId;
    appliedSnapshotSeqRef.current = -1;
    lastAppliedOutputSeqRef.current = -1;
    lastReportedSizeRef.current = null;
    terminalRef.current?.reset();
  }, [activeCardId]);

  // Fit the terminal to its container and report the new size through the
  // optional bridge resize channel.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const applyFit = () => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!terminal || !fitAddon) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const reportResize = onResizeRef.current;
      if (reportResize && terminal.cols >= 1 && terminal.rows >= 1) {
        const last = lastReportedSizeRef.current;
        if (!last || last.cols !== terminal.cols || last.rows !== terminal.rows) {
          lastReportedSizeRef.current = { cols: terminal.cols, rows: terminal.rows };
          reportResize(terminal.cols, terminal.rows);
        }
      }
    };

    // Defer the initial fit to after layout settles. Running fit() during the
    // synchronous mount can measure a not-yet-laid-out flex container and yield
    // degenerate dimensions (1x1), which on iOS leaves nothing painted. A
    // double requestAnimationFrame waits for the browser to flush layout before
    // the first fit.
    let rafOuter = 0;
    let rafInner = 0;
    let pendingFitFrame = 0;
    const scheduleFit = () => {
      if (typeof requestAnimationFrame !== 'function') {
        applyFit();
        return;
      }
      if (pendingFitFrame) return;
      pendingFitFrame = requestAnimationFrame(() => {
        pendingFitFrame = 0;
        applyFit();
      });
    };
    if (typeof requestAnimationFrame === 'function') {
      rafOuter = requestAnimationFrame(() => {
        rafInner = requestAnimationFrame(() => {
          scheduleFit();
        });
      });
    } else {
      applyFit();
    }

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => scheduleFit());
      observer.observe(host);
    }
    const onViewportChange = () => scheduleFit();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    window.visualViewport?.addEventListener('resize', onViewportChange);
    window.visualViewport?.addEventListener('scroll', onViewportChange);

    return () => {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafOuter);
        cancelAnimationFrame(rafInner);
        cancelAnimationFrame(pendingFitFrame);
      }
      observer?.disconnect();
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
      window.visualViewport?.removeEventListener('resize', onViewportChange);
      window.visualViewport?.removeEventListener('scroll', onViewportChange);
    };
  }, []);

  // Apply bridge messages: snapshots reset, outputs append. Sequence guards
  // make repeated snapshots / already-applied outputs no-ops so re-renders do
  // not flash or duplicate content.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !activeCardId) return;

    for (const message of messages) {
      if (message.kind === 'terminal_snapshot') {
        const snapshot = message.snapshot;
        if (snapshot.cardId !== activeCardId) continue;
        const seq = Number(snapshot.seq ?? 0);
        if (seq === appliedSnapshotSeqRef.current) continue;
        if (seq <= lastAppliedOutputSeqRef.current && appliedSnapshotSeqRef.current !== -1) {
          continue;
        }
        terminal.reset();
        terminal.write(snapshotPayload(snapshot));
        // Kick a redraw of the full viewport. xterm's DOM renderer on iOS
        // WKWebView occasionally does not self-paint the first frame right
        // after a reset; an explicit refresh forces the initial screen to
        // appear instead of staying black.
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        appliedSnapshotSeqRef.current = seq;
        lastAppliedOutputSeqRef.current = seq;
        continue;
      }
      if (message.kind === 'terminal_output') {
        if (message.card_id !== activeCardId) continue;
        const seq = Number(message.seq ?? 0);
        if (seq <= lastAppliedOutputSeqRef.current) continue;
        terminal.write(message.data);
        lastAppliedOutputSeqRef.current = seq;
      }
    }
  }, [activeCardId, messages]);

  // The host div is ALWAYS rendered so hostRef stays stable. The create-effect
  // therefore reliably creates the xterm instance exactly once and never
  // depends on the host happening to exist on a particular render frame. The
  // empty state is an absolutely positioned overlay sibling shown only while
  // no card is active (it never replaces / unmounts the host).
  const scrollClassName = [
    'terminal-scroll',
    mode === 'preview' ? 'terminal-scroll-preview' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={scrollClassName} aria-label="Terminal output">
      <div className="terminal-xterm-host" ref={hostRef} />
      {!activeCardId && (
        <div
          className={`terminal-empty-overlay ${
            mode === 'preview' ? 'terminal-empty-overlay-preview' : ''
          }`}
        >
          <span>No live terminal sessions yet.</span>
        </div>
      )}
    </div>
  );
}
