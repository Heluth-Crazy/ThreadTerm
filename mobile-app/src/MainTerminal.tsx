import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  getTerminalFeedBacklog,
  subscribeTerminalFeed,
  type TerminalFeedMessage,
} from './terminalFeed';

// P2 architecture: a single xterm instance drives both preview and detail
// surfaces. The bridge protocol contract is unchanged:
//   - terminal_snapshot = a wezterm full-screen serialization. It is a RESET
//     boundary: reset() then write(history + screen).
//   - terminal_output   = incremental data. It is an APPEND: write(data).
// The AnsiStreamClassifier / ChatBlock / TuiBlock path is intentionally no
// longer referenced here (kept on disk for rollback), so streaming AI CLI
// output is mirrored exactly like the desktop terminal without block chrome.
//
// Renderer strategy: xterm's DEFAULT DOM renderer.
// Canvas/WebGL renderers can reduce scroll paint cost, but real iOS WKWebView
// testing showed the same unacceptable failure mode: the addon can load
// successfully while the terminal area remains black. Since the mobile goal is
// "always show the desktop terminal content", content visibility takes
// precedence over renderer acceleration.

interface MainTerminalProps {
  activeCardId: string | null;
  mode?: 'detail' | 'preview';
  className?: string;
  // Optional resize observer for tests or future local-only consumers. The
  // mobile app intentionally does not wire this to the desktop PTY: phone
  // keyboard / viewport changes must not resize the desktop-owned session.
  onResize?: (cols: number, rows: number) => void;
  // Monotonic counter bumped by App ONLY on server backpressure
  // (broadcast Lagged -> error/backpressure). A change re-arms the snapshot
  // epoch once so the immediately-following recovery terminal_snapshot is
  // applied as a recovery reset and the dropped output segment is repainted.
  // Plain reconnects never bump this, so the issue-5 guard is unaffected.
  recoveryNonce?: number;
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

// Detail scrollback is a deliberate balance: deep enough that scrolling up to
// review earlier output stays useful, but not so deep that the DOM renderer's
// momentum-scroll surface (rows * lineHeight) becomes janky in iOS WKWebView.
// 2500 lines is 2.5x xterm's default and keeps the DOM surface bounded while
// still retaining ample upward history.
const DETAIL_SCROLLBACK = 2500;
const PREVIEW_SCROLLBACK = 160;
const DETAIL_FONT_SIZE = 13;
const PREVIEW_FONT_SIZE = 11;
const MIN_DETAIL_FONT_SIZE = 5;
const MIN_PREVIEW_FONT_SIZE = 5;
const XTERM_HOST_PADDING_X = 8;
const XTERM_HOST_PADDING_Y = 8;
const MONOSPACE_CELL_WIDTH_RATIO = 0.62;

type TerminalSize = {
  cols: number;
  rows: number;
};

function snapshotPayload(snapshot: {
  history?: string;
  data: string;
}): string {
  return [snapshot.history, snapshot.data].filter(Boolean).join('');
}

function snapshotSize(snapshot: { cols: number; rows: number }): TerminalSize | null {
  if (!Number.isFinite(snapshot.cols) || !Number.isFinite(snapshot.rows)) return null;
  const cols = Math.floor(snapshot.cols);
  const rows = Math.floor(snapshot.rows);
  if (cols < 1 || rows < 1) return null;
  return { cols, rows };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mirroredFontSize(
  host: HTMLElement,
  size: TerminalSize,
  mode: 'detail' | 'preview',
): number {
  const maxFontSize = mode === 'preview' ? PREVIEW_FONT_SIZE : DETAIL_FONT_SIZE;
  const minFontSize = mode === 'preview' ? MIN_PREVIEW_FONT_SIZE : MIN_DETAIL_FONT_SIZE;
  const usableWidth = Math.max(1, host.clientWidth - XTERM_HOST_PADDING_X);
  const usableHeight = Math.max(1, host.clientHeight - XTERM_HOST_PADDING_Y);
  const byCols = usableWidth / Math.max(1, size.cols) / MONOSPACE_CELL_WIDTH_RATIO;
  const byRows = usableHeight / Math.max(1, size.rows) / 1.2;
  const next = clamp(Math.min(maxFontSize, byCols, byRows), minFontSize, maxFontSize);
  return Math.floor(next * 10) / 10;
}

function applyMirroredTerminalSize(
  terminal: Terminal,
  host: HTMLElement | null,
  size: TerminalSize | null,
  mode: 'detail' | 'preview',
): boolean {
  if (!host || !size) return false;
  const fontSize = mirroredFontSize(host, size, mode);
  if (terminal.options.fontSize !== fontSize) {
    terminal.options.fontSize = fontSize;
  }
  if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
    terminal.resize(size.cols, size.rows);
  }
  terminal.refresh(0, Math.max(0, terminal.rows - 1));
  return true;
}

export function MainTerminal({
  activeCardId,
  mode = 'detail',
  className = '',
  onResize,
  recoveryNonce = 0,
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
  const sourceSizeRef = useRef<TerminalSize | null>(null);
  // The backpressure nonce already observed. Initialized to the mount value so
  // a surface that mounts after a prior backpressure does NOT spuriously
  // re-arm; only a genuine increment while this instance is alive does.
  const lastRecoveryNonceRef = useRef<number>(recoveryNonce);

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
      fontSize: mode === 'preview' ? PREVIEW_FONT_SIZE : DETAIL_FONT_SIZE,
      lineHeight: 1.2,
      scrollback: mode === 'preview' ? PREVIEW_SCROLLBACK : DETAIL_SCROLLBACK,
      // Instant (non-animated) scroll: animated smooth-scroll runs a
      // main-thread rAF loop that compounds the DOM renderer's per-row repaint
      // cost during a large-output burst on mobile. 0 = jump directly.
      smoothScrollDuration: 0,
      theme: { ...DARK_THEME },
    });
    terminalRef.current = terminal;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);

    terminal.open(host);

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
    sourceSizeRef.current = null;
    terminalRef.current?.reset();
  }, [activeCardId]);

  // Fit before a snapshot exists. After the first terminal_snapshot, the
  // source PTY dimensions become authoritative: ANSI cursor addressing from AI
  // CLIs only renders correctly when the mirror uses the same rows/cols as the
  // producer. Mobile viewport changes adjust font size, never the desktop PTY.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const applyFit = () => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!terminal || !fitAddon) return;
      if (applyMirroredTerminalSize(terminal, host, sourceSizeRef.current, mode)) {
        return;
      }
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
  }, [mode]);

  // Backpressure recovery: when App bumps recoveryNonce (server broadcast
  // Lagged -> error/backpressure), re-arm the snapshot epoch ONCE so the
  // recovery terminal_snapshot fetched right after is applied as a recovery
  // reset and the dropped terminal_output segment is repainted. This does NOT
  // touch lastAppliedOutputSeqRef: the snapshot branch sets it to snapshot.seq
  // (same monotonic output_seq source), so any stale lower/equal-seq output
  // replayed afterward is still correctly dropped by the :seq guard. Plain
  // reconnects never bump recoveryNonce, so issue-5 (history survives a
  // reconnect snapshot) is fully preserved.
  useEffect(() => {
    if (recoveryNonce === lastRecoveryNonceRef.current) return;
    lastRecoveryNonceRef.current = recoveryNonce;
    appliedSnapshotSeqRef.current = -1;
  }, [recoveryNonce]);

  // Apply bridge messages: snapshots reset, outputs append. Sequence guards
  // make repeated snapshots / already-applied outputs no-ops so replays do
  // not flash or duplicate content.
  //
  // Stage 5 (audit P1-3): messages no longer arrive as a React-state array
  // prop. The terminalFeed module owns per-card buckets; this effect replays
  // the card's backlog once, then subscribes for increments which are written
  // straight into xterm — no App re-render, no full-transcript loop per chunk.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !activeCardId) return;

    const applyFeedMessage = (message: TerminalFeedMessage) => {
      if (message.kind === 'terminal_snapshot') {
        const snapshot = message.snapshot;
        if (snapshot.cardId !== activeCardId) return;
        const nextSourceSize = snapshotSize(snapshot);
        if (nextSourceSize) {
          sourceSizeRef.current = nextSourceSize;
          applyMirroredTerminalSize(terminal, hostRef.current, nextSourceSize, mode);
        }
        // Protocol invariant: terminal_snapshot is ONLY emitted on (re)connect
        // (server initial_messages_for_client). In-session screen redraws
        // (alt-screen, full repaints) arrive as raw ANSI in terminal_output,
        // never as a new snapshot. Therefore the FIRST snapshot for this
        // card-epoch is the real screen and gets a destructive reset; every
        // later snapshot is a reconnect resync. Resetting on a resync wipes
        // the scrollback the user is actively reading — that is the "history
        // disappears after send + reply" bug (a send easily triggers a
        // visibility/keyboard reconnect). So skip later snapshots entirely and
        // let seq-guarded terminal_output continue the live stream in place.
        if (appliedSnapshotSeqRef.current !== -1) return;
        const seq = Number(snapshot.seq ?? 0);
        terminal.reset();
        terminal.write(snapshotPayload(snapshot));
        // Kick a redraw of the full viewport. xterm's DOM renderer on iOS
        // WKWebView occasionally does not self-paint the first frame right
        // after a reset; an explicit refresh forces the initial screen to
        // appear instead of staying black.
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        appliedSnapshotSeqRef.current = seq;
        lastAppliedOutputSeqRef.current = seq;
        return;
      }
      if (message.kind === 'terminal_output') {
        if (message.card_id !== activeCardId) return;
        if (!sourceSizeRef.current && appliedSnapshotSeqRef.current === -1) return;
        const seq = Number(message.seq ?? 0);
        if (seq <= lastAppliedOutputSeqRef.current) return;
        terminal.write(message.data);
        lastAppliedOutputSeqRef.current = seq;
      }
    };

    for (const message of getTerminalFeedBacklog(activeCardId)) {
      applyFeedMessage(message);
    }
    return subscribeTerminalFeed(activeCardId, applyFeedMessage);
  }, [activeCardId, mode]);

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
