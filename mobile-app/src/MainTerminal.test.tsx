import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from './i18n';

// MainTerminal calls useI18n() for its empty-state copy, so every render must
// sit inside an I18nProvider. Passing this wrapper to render() also propagates
// to rerender(), keeping the existing sequencing assertions untouched.
function I18nWrapper({ children }: { children: ReactNode }) {
  return <I18nProvider search="">{children}</I18nProvider>;
}

const wrapper = I18nWrapper;

// Mock @xterm/xterm. Hoisted because vi.mock factories run before the module
// imports below. Style mirrors blocks/TuiBlock.test.tsx.
const xtermMock = vi.hoisted(() => {
  const instances: Array<{
    dispose: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    cols: number;
    rows: number;
    options: Record<string, unknown>;
  }> = [];

  const Terminal = vi.fn(function Terminal(options: Record<string, unknown>) {
    const instance = {
      dispose: vi.fn(),
      loadAddon: vi.fn(),
      open: vi.fn(),
      refresh: vi.fn(),
      reset: vi.fn(),
      resize: vi.fn((cols: number, rows: number) => {
        instance.cols = cols;
        instance.rows = rows;
      }),
      write: vi.fn(),
      cols: 80,
      rows: 24,
      options: { ...options },
    };
    instances.push(instance);
    return instance;
  });

  return { Terminal, instances };
});

const fitAddonMock = vi.hoisted(() => ({
  FitAddon: vi.fn(function FitAddon(this: { fit: ReturnType<typeof vi.fn> }) {
    this.fit = vi.fn();
  }),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: xtermMock.Terminal,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: fitAddonMock.FitAddon,
}));

// NOTE: @xterm/addon-webgl is intentionally NOT mocked. MainTerminal no longer
// imports it — xterm runs on its default DOM renderer so the terminal text is
// always painted into the DOM (iOS WKWebView canvas/WebGL black-screen
// regressions).

import { MainTerminal } from './MainTerminal';
import {
  pushTerminalFeedMessage,
  resetTerminalFeed,
  type TerminalFeedMessage,
} from './terminalFeed';

// Stage 5 (audit P1-3): messages no longer flow in as a React prop array.
// Tests feed the per-card terminalFeed instead — pushes BEFORE render exercise
// the backlog-replay path, pushes AFTER render exercise the live subscription
// path. All sequencing assertions below are unchanged: they are the issue-5 /
// backpressure D1 regression net.

function snapshotMessage(
  cardId: string,
  seq: number,
  data: string,
  size: { rows: number; cols: number } = { rows: 24, cols: 80 },
): TerminalFeedMessage {
  return {
    protocol_version: 1,
    kind: 'terminal_snapshot',
    snapshot: {
      cardId,
      data,
      seq,
      rows: size.rows,
      cols: size.cols,
      cursorRow: 0,
      cursorCol: 0,
    },
  } as unknown as TerminalFeedMessage;
}

function outputMessage(cardId: string, seq: number, data: string): TerminalFeedMessage {
  return {
    protocol_version: 1,
    kind: 'terminal_output',
    card_id: cardId,
    seq,
    data,
  } as unknown as TerminalFeedMessage;
}

describe('MainTerminal', () => {
  afterEach(() => {
    cleanup();
    resetTerminalFeed();
    xtermMock.Terminal.mockClear();
    xtermMock.instances.length = 0;
    fitAddonMock.FitAddon.mockClear();
  });

  it('creates a single xterm instance, opens it, and writes the first snapshot via reset', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP'));

    render(<MainTerminal activeCardId="card-1" />, { wrapper });

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    const term = xtermMock.instances[0];
    expect(term.open).toHaveBeenCalledTimes(1);
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenLastCalledWith('SNAP');
  });

  it('uses bounded scrollback in preview mode', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP'));

    render(<MainTerminal activeCardId="card-1" mode="preview" />, { wrapper });

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].options.scrollback).toBe(160);
  });

  it('keeps deeper-but-bounded scrollback and instant scroll in detail mode', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP'));

    render(<MainTerminal activeCardId="card-1" />, { wrapper });

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    // Bounded at 2500 (down from 4000) so the iOS WKWebView momentum-scroll
    // surface stays smooth while still retaining ample upward history.
    expect(xtermMock.instances[0].options.scrollback).toBe(2500);
    // Animated smooth-scroll disabled to avoid main-thread rAF jank on large
    // output bursts.
    expect(xtermMock.instances[0].options.smoothScrollDuration).toBe(0);
  });

  it('skips re-applying a snapshot with the same seq (no flicker on re-render)', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP'));
    const { rerender } = render(<MainTerminal activeCardId="card-1" />, { wrapper });

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledTimes(1);

    // The same snapshot seq arrives again (duplicated push) plus a re-render.
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP'));
    rerender(<MainTerminal activeCardId="card-1" />);

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledTimes(1);
  });

  it('appends incremental output for increasing seq and skips already-applied seq', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP'));
    pushTerminalFeedMessage(outputMessage('card-1', 2, 'A'));
    render(<MainTerminal activeCardId="card-1" />, { wrapper });

    const term = xtermMock.instances[0];
    expect(term.write).toHaveBeenNthCalledWith(1, 'SNAP');
    expect(term.write).toHaveBeenNthCalledWith(2, 'A');

    // 'A' (seq 2) replayed again must not be re-written; only 'B'.
    pushTerminalFeedMessage(outputMessage('card-1', 2, 'A'));
    pushTerminalFeedMessage(outputMessage('card-1', 3, 'B'));

    expect(term.write).toHaveBeenCalledTimes(3);
    expect(term.write).toHaveBeenLastCalledWith('B');
  });

  it('does not apply a stale snapshot after newer output has already been written', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP1'));
    pushTerminalFeedMessage(outputMessage('card-1', 3, 'A'));
    render(<MainTerminal activeCardId="card-1" />, { wrapper });

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenNthCalledWith(1, 'SNAP1');
    expect(term.write).toHaveBeenNthCalledWith(2, 'A');

    pushTerminalFeedMessage(snapshotMessage('card-1', 2, 'STALE'));

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledTimes(2);
    expect(term.write).not.toHaveBeenCalledWith('STALE');
  });

  it('treats a later snapshot as a non-destructive reconnect resync (issue 5)', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP1'));
    pushTerminalFeedMessage(outputMessage('card-1', 2, 'A'));
    render(<MainTerminal activeCardId="card-1" />, { wrapper });

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenLastCalledWith('A');

    // A reconnect re-sends a fresh terminal_snapshot with a higher seq plus
    // continued output. The snapshot must NOT reset (that would wipe the
    // scrollback the user is reading); seq-guarded output continues in place.
    pushTerminalFeedMessage(snapshotMessage('card-1', 5, 'SNAP2'));
    pushTerminalFeedMessage(outputMessage('card-1', 6, 'B'));

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).not.toHaveBeenCalledWith('SNAP2');
    expect(term.write).toHaveBeenCalledTimes(3);
    expect(term.write).toHaveBeenLastCalledWith('B');
  });

  it('re-applies the recovery snapshot once when recoveryNonce bumps (D1 backpressure)', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP1'));
    pushTerminalFeedMessage(outputMessage('card-1', 2, 'A'));
    const { rerender } = render(
      <MainTerminal activeCardId="card-1" recoveryNonce={0} />,
      { wrapper },
    );

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenLastCalledWith('A');

    // Server backpressure: App bumps recoveryNonce FIRST, then fetches a
    // recovery snapshot (higher seq, carries the dropped segment). The epoch
    // is re-armed so this snapshot IS applied as a recovery reset.
    rerender(<MainTerminal activeCardId="card-1" recoveryNonce={1} />);
    pushTerminalFeedMessage(snapshotMessage('card-1', 10, 'RECOVERY'));
    pushTerminalFeedMessage(outputMessage('card-1', 11, 'C'));

    expect(term.reset).toHaveBeenCalledTimes(2);
    expect(term.write).toHaveBeenCalledWith('RECOVERY');
    expect(term.write).toHaveBeenLastCalledWith('C');

    // A stale lower/equal seq replayed after recovery is still dropped: the
    // snapshot reset lastAppliedOutputSeq to 10.
    pushTerminalFeedMessage(outputMessage('card-1', 2, 'STALE'));

    expect(term.reset).toHaveBeenCalledTimes(2);
    expect(term.write).not.toHaveBeenCalledWith('STALE');
  });

  it('does not re-arm on a plain reconnect when recoveryNonce is unchanged (issue-5 preserved)', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP1'));
    pushTerminalFeedMessage(outputMessage('card-1', 2, 'A'));
    const { rerender } = render(
      <MainTerminal activeCardId="card-1" recoveryNonce={0} />,
      { wrapper },
    );

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);

    // Plain reconnect: a higher-seq snapshot arrives but recoveryNonce stays 0
    // (App only bumps it on backpressure). The issue-5 guard must still ignore
    // the snapshot so scrollback is not wiped.
    rerender(<MainTerminal activeCardId="card-1" recoveryNonce={0} />);
    pushTerminalFeedMessage(snapshotMessage('card-1', 5, 'SNAP2'));
    pushTerminalFeedMessage(outputMessage('card-1', 6, 'B'));

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).not.toHaveBeenCalledWith('SNAP2');
    expect(term.write).toHaveBeenLastCalledWith('B');
  });

  it('does not re-arm when mounting at a non-zero recoveryNonce (no spurious recovery reset)', () => {
    // A surface (e.g. detail) can mount AFTER a prior backpressure already
    // bumped the shared nonce. Mounting at nonce=3 must not treat the first
    // snapshot any differently — only a genuine increment while alive re-arms.
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP1'));
    pushTerminalFeedMessage(outputMessage('card-1', 2, 'A'));
    const { rerender } = render(
      <MainTerminal activeCardId="card-1" recoveryNonce={3} />,
      { wrapper },
    );

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);

    // Same nonce, higher-seq reconnect snapshot: still ignored (issue-5).
    rerender(<MainTerminal activeCardId="card-1" recoveryNonce={3} />);
    pushTerminalFeedMessage(snapshotMessage('card-1', 9, 'SNAP2'));
    pushTerminalFeedMessage(outputMessage('card-1', 10, 'B'));

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).not.toHaveBeenCalledWith('SNAP2');
    expect(term.write).toHaveBeenLastCalledWith('B');
  });

  it('resets again only when the active card changes, not on a reconnect snapshot', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP1'));
    pushTerminalFeedMessage(outputMessage('card-1', 2, 'A'));
    const { rerender } = render(<MainTerminal activeCardId="card-1" />, { wrapper });

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);

    // Switching card is a real new epoch: the next card's first snapshot
    // resets and paints.
    pushTerminalFeedMessage(snapshotMessage('card-2', 9, 'SNAP-C2'));
    rerender(<MainTerminal activeCardId="card-2" />);

    // One reset for the card switch + one for card-2's first snapshot.
    expect(term.reset).toHaveBeenCalledTimes(3);
    expect(term.write).toHaveBeenLastCalledWith('SNAP-C2');
  });

  it('renders with the default DOM renderer (no Canvas/WebGL addon imported)', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP'));

    render(<MainTerminal activeCardId="card-1" />, { wrapper });

    // Only the FitAddon is loaded onto the terminal. Canvas/WebGL addons were
    // removed because real iOS WKWebView can load them successfully while the
    // terminal area remains black; DOM text is the reliable visibility path.
    const term = xtermMock.instances[0];
    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
    expect(term.open).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenLastCalledWith('SNAP');
  });

  it('disposes the xterm instance on unmount', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP'));
    const { unmount } = render(<MainTerminal activeCardId="card-1" />, { wrapper });

    const term = xtermMock.instances[0];
    expect(term.dispose).not.toHaveBeenCalled();

    unmount();

    expect(term.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps the xterm host mounted and shows an empty overlay when no card is active', () => {
    const { container } = render(<MainTerminal activeCardId={null} />, { wrapper });

    // Root cause 2 fix: the host div is ALWAYS rendered so hostRef is stable
    // and the create-effect reliably builds the terminal exactly once. The
    // empty state is an overlay sibling, not an early-return replacement.
    expect(container.querySelector('.terminal-xterm-host')).not.toBeNull();
    expect(container.querySelector('.terminal-empty-overlay')).not.toBeNull();
    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
  });

  it('forces a redraw after applying a snapshot so the first frame is not black', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP'));
    pushTerminalFeedMessage(outputMessage('card-1', 2, 'OUT'));

    render(<MainTerminal activeCardId="card-1" />, { wrapper });

    // The DOM renderer occasionally does not self-paint the first frame after
    // a reset on iOS WKWebView; the explicit refresh() forces the initial
    // screen to appear instead of staying black.
    const term = xtermMock.instances[0];
    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(term.open).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenNthCalledWith(1, 'SNAP');
    expect(term.write).toHaveBeenNthCalledWith(2, 'OUT');
    expect(term.refresh).toHaveBeenCalled();
  });

  it('uses snapshot PTY dimensions as the mobile mirror size', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP', { rows: 32, cols: 120 }));

    render(<MainTerminal activeCardId="card-1" />, { wrapper });

    // Mobile must mirror the PTY's source rows/cols instead of fitting to the
    // phone width. Otherwise ANSI cursor addressing from AI CLIs is interpreted
    // at a different column grid and leaves edge fragments / scrambled rows.
    const term = xtermMock.instances[0];
    expect(term.resize).toHaveBeenCalledWith(120, 32);
    expect(term.cols).toBe(120);
    expect(term.rows).toBe(32);
    expect(term.write).toHaveBeenLastCalledWith('SNAP');
  });

  it('does not write live output before a snapshot supplies source dimensions', () => {
    render(<MainTerminal activeCardId="card-1" />, { wrapper });

    pushTerminalFeedMessage(outputMessage('card-1', 5, 'EARLY_OUTPUT'));

    const term = xtermMock.instances[0];
    expect(term.write).not.toHaveBeenCalledWith('EARLY_OUTPUT');
    expect(term.resize).not.toHaveBeenCalled();

    // Once the snapshot lands, the feed re-delivers the retained early output
    // after it, so the live surface catches up without a remount.
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP', { rows: 32, cols: 120 }));

    expect(term.resize).toHaveBeenCalledWith(120, 32);
    expect(term.write).toHaveBeenNthCalledWith(1, 'SNAP');
    expect(term.write).toHaveBeenNthCalledWith(2, 'EARLY_OUTPUT');
  });

  it('remounts from a capped transcript after a large output burst', () => {
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP'));
    for (let index = 0; index < 2100; index += 1) {
      pushTerminalFeedMessage(outputMessage('card-1', index + 2, `chunk-${index}`));
    }

    render(<MainTerminal activeCardId="card-1" />, { wrapper });

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenNthCalledWith(1, 'SNAP');
    expect(term.write).toHaveBeenLastCalledWith('chunk-2099');
    // Backlog replay is bounded by the per-card cap: snapshot + 1999 outputs.
    expect(term.write).toHaveBeenCalledTimes(2000);
  });

  it('writes the snapshot after activeCardId goes null -> non-null without remount or mode change (root cause 2)', () => {
    const { rerender } = render(<MainTerminal activeCardId={null} />, { wrapper });

    // Terminal is created up-front because the host is always mounted.
    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    const term = xtermMock.instances[0];
    expect(term.write).not.toHaveBeenCalled();

    // Card becomes active later (no remount, no mode change). The already
    // created terminal must receive the snapshot from the backlog replay.
    pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP'));
    rerender(<MainTerminal activeCardId="card-1" />);

    // Same single instance — not recreated.
    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(term.reset).toHaveBeenCalled();
    expect(term.write).toHaveBeenLastCalledWith('SNAP');
  });

  it('reports fitted dimensions before a snapshot supplies source dimensions', async () => {
    const onResize = vi.fn();
    render(<MainTerminal activeCardId={null} onResize={onResize} />, { wrapper });

    // Before any snapshot arrives, the component can still use FitAddon as a
    // local empty-state fallback and report the fitted dimensions to tests /
    // future local-only consumers.
    await vi.waitFor(() => {
      expect(onResize).toHaveBeenCalledWith(80, 24);
    });
  });

  it('keeps visualViewport refits local to the mirrored PTY dimensions', async () => {
    const originalVisualViewport = window.visualViewport;
    const animationFrames: FrameRequestCallback[] = [];
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientWidth',
    );
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight',
    );
    const hostSize = { width: 320, height: 240 };
    const flushAnimationFrame = () => {
      const frame = animationFrames.shift();
      if (!frame) throw new Error('Expected a scheduled animation frame');
      frame(performance.now());
    };
    const handlers: Record<string, (event: Event) => void> = {};
    const visualViewport = {
      addEventListener: vi.fn((type: string, handler: (event: Event) => void) => {
        handlers[type] = handler;
      }),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      }),
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return this.classList?.contains('terminal-xterm-host') ? hostSize.width : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('terminal-xterm-host') ? hostSize.height : 0;
      },
    });

    try {
      const onResize = vi.fn();
      pushTerminalFeedMessage(snapshotMessage('card-1', 1, 'SNAP', { rows: 32, cols: 120 }));
      const { unmount } = render(
        <MainTerminal activeCardId="card-1" onResize={onResize} />,
        { wrapper },
      );

      const term = xtermMock.instances[0];
      const fitAddon = term.loadAddon.mock.calls[0][0] as {
        fit: ReturnType<typeof vi.fn>;
      };
      expect(term.resize).toHaveBeenCalledWith(120, 32);
      fitAddon.fit.mockClear();
      term.resize.mockClear();
      term.refresh.mockClear();
      onResize.mockClear();

      flushAnimationFrame();
      flushAnimationFrame();
      flushAnimationFrame();
      expect(fitAddon.fit).not.toHaveBeenCalled();
      expect(term.resize).not.toHaveBeenCalled();
      expect(term.refresh).toHaveBeenCalled();
      expect(onResize).not.toHaveBeenCalled();

      expect(visualViewport.addEventListener).toHaveBeenCalledWith('resize', handlers.resize);
      expect(visualViewport.addEventListener).toHaveBeenCalledWith('scroll', handlers.scroll);
      term.refresh.mockClear();
      window.dispatchEvent(new Event('resize'));
      expect(animationFrames).toHaveLength(1);
      flushAnimationFrame();
      expect(fitAddon.fit).not.toHaveBeenCalled();
      expect(term.resize).not.toHaveBeenCalled();
      expect(term.refresh).toHaveBeenCalled();
      expect(onResize).not.toHaveBeenCalled();

      hostSize.width = 360;
      handlers.resize(new Event('resize'));
      expect(animationFrames).toHaveLength(1);
      flushAnimationFrame();
      expect(fitAddon.fit).not.toHaveBeenCalled();
      expect(term.resize).not.toHaveBeenCalled();
      expect(onResize).not.toHaveBeenCalled();

      unmount();
      expect(visualViewport.removeEventListener).toHaveBeenCalledWith('resize', handlers.resize);
      expect(visualViewport.removeEventListener).toHaveBeenCalledWith('scroll', handlers.scroll);
    } finally {
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: originalVisualViewport,
      });
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: originalRequestAnimationFrame,
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        value: originalCancelAnimationFrame,
      });
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
      }
    }
  });
});
