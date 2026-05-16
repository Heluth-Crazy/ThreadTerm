import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@shared/mobile/bridge/protocol';

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
      resize: vi.fn(),
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
// always painted into the DOM (iOS WKWebView WebGL black-screen regression).

import { MainTerminal } from './MainTerminal';

function snapshotMessage(cardId: string, seq: number, data: string): ServerMessage {
  return {
    protocol_version: 1,
    kind: 'terminal_snapshot',
    snapshot: {
      cardId,
      data,
      seq,
      rows: 24,
      cols: 80,
      cursorRow: 0,
      cursorCol: 0,
    },
  } as unknown as ServerMessage;
}

function outputMessage(cardId: string, seq: number, data: string): ServerMessage {
  return {
    protocol_version: 1,
    kind: 'terminal_output',
    card_id: cardId,
    seq,
    data,
  } as unknown as ServerMessage;
}

describe('MainTerminal', () => {
  afterEach(() => {
    cleanup();
    xtermMock.Terminal.mockClear();
    xtermMock.instances.length = 0;
    fitAddonMock.FitAddon.mockClear();
  });

  it('creates a single xterm instance, opens it, and writes the first snapshot via reset', () => {
    render(
      <MainTerminal
        activeCardId="card-1"
        messages={[snapshotMessage('card-1', 1, 'SNAP')]}
      />,
    );

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    const term = xtermMock.instances[0];
    expect(term.open).toHaveBeenCalledTimes(1);
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenLastCalledWith('SNAP');
  });

  it('uses bounded scrollback in preview mode', () => {
    render(
      <MainTerminal
        activeCardId="card-1"
        messages={[snapshotMessage('card-1', 1, 'SNAP')]}
        mode="preview"
      />,
    );

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].options.scrollback).toBe(160);
  });

  it('keeps deeper-but-bounded scrollback and instant scroll in detail mode', () => {
    render(
      <MainTerminal
        activeCardId="card-1"
        messages={[snapshotMessage('card-1', 1, 'SNAP')]}
      />,
    );

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    // Bounded at 2500 (down from 4000) so the iOS WKWebView momentum-scroll
    // surface stays smooth while still retaining ample upward history.
    expect(xtermMock.instances[0].options.scrollback).toBe(2500);
    // Animated smooth-scroll disabled to avoid main-thread rAF jank on large
    // output bursts.
    expect(xtermMock.instances[0].options.smoothScrollDuration).toBe(0);
  });

  it('skips re-applying a snapshot with the same seq (no flicker on re-render)', () => {
    const messages = [snapshotMessage('card-1', 1, 'SNAP')];
    const { rerender } = render(
      <MainTerminal activeCardId="card-1" messages={messages} />,
    );

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledTimes(1);

    // Same snapshot object/seq arrives again on re-render.
    rerender(<MainTerminal activeCardId="card-1" messages={[...messages]} />);

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledTimes(1);
  });

  it('appends incremental output for increasing seq and skips already-applied seq', () => {
    const { rerender } = render(
      <MainTerminal
        activeCardId="card-1"
        messages={[
          snapshotMessage('card-1', 1, 'SNAP'),
          outputMessage('card-1', 2, 'A'),
        ]}
      />,
    );

    const term = xtermMock.instances[0];
    expect(term.write).toHaveBeenNthCalledWith(1, 'SNAP');
    expect(term.write).toHaveBeenNthCalledWith(2, 'A');

    rerender(
      <MainTerminal
        activeCardId="card-1"
        messages={[
          snapshotMessage('card-1', 1, 'SNAP'),
          outputMessage('card-1', 2, 'A'),
          outputMessage('card-1', 3, 'B'),
        ]}
      />,
    );

    // 'A' (seq 2) is already applied and must not be re-written; only 'B'.
    expect(term.write).toHaveBeenCalledTimes(3);
    expect(term.write).toHaveBeenLastCalledWith('B');
  });

  it('does not apply a stale snapshot after newer output has already been written', () => {
    const { rerender } = render(
      <MainTerminal
        activeCardId="card-1"
        messages={[
          snapshotMessage('card-1', 1, 'SNAP1'),
          outputMessage('card-1', 3, 'A'),
        ]}
      />,
    );

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenNthCalledWith(1, 'SNAP1');
    expect(term.write).toHaveBeenNthCalledWith(2, 'A');

    rerender(
      <MainTerminal
        activeCardId="card-1"
        messages={[
          snapshotMessage('card-1', 2, 'STALE'),
          outputMessage('card-1', 3, 'A'),
        ]}
      />,
    );

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledTimes(2);
    expect(term.write).not.toHaveBeenCalledWith('STALE');
  });

  it('treats a later snapshot as a non-destructive reconnect resync (issue 5)', () => {
    const { rerender } = render(
      <MainTerminal
        activeCardId="card-1"
        messages={[
          snapshotMessage('card-1', 1, 'SNAP1'),
          outputMessage('card-1', 2, 'A'),
        ]}
      />,
    );

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenLastCalledWith('A');

    // A reconnect re-sends a fresh terminal_snapshot with a higher seq plus
    // continued output. The snapshot must NOT reset (that would wipe the
    // scrollback the user is reading); seq-guarded output continues in place.
    rerender(
      <MainTerminal
        activeCardId="card-1"
        messages={[
          snapshotMessage('card-1', 5, 'SNAP2'),
          outputMessage('card-1', 6, 'B'),
        ]}
      />,
    );

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).not.toHaveBeenCalledWith('SNAP2');
    expect(term.write).toHaveBeenCalledTimes(3);
    expect(term.write).toHaveBeenLastCalledWith('B');
  });

  it('resets again only when the active card changes, not on a reconnect snapshot', () => {
    const { rerender } = render(
      <MainTerminal
        activeCardId="card-1"
        messages={[snapshotMessage('card-1', 1, 'SNAP1'), outputMessage('card-1', 2, 'A')]}
      />,
    );

    const term = xtermMock.instances[0];
    expect(term.reset).toHaveBeenCalledTimes(1);

    // Switching card is a real new epoch: the next card's first snapshot
    // resets and paints.
    rerender(
      <MainTerminal
        activeCardId="card-2"
        messages={[snapshotMessage('card-2', 9, 'SNAP-C2')]}
      />,
    );

    // One reset for the card switch + one for card-2's first snapshot.
    expect(term.reset).toHaveBeenCalledTimes(3);
    expect(term.write).toHaveBeenLastCalledWith('SNAP-C2');
  });

  it('renders with the default DOM renderer (no WebGL addon imported)', () => {
    render(
      <MainTerminal
        activeCardId="card-1"
        messages={[snapshotMessage('card-1', 1, 'SNAP')]}
      />,
    );

    // Only the FitAddon is loaded onto the terminal. The WebGL addon was
    // removed so xterm paints text into the DOM on iOS WKWebView.
    const term = xtermMock.instances[0];
    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
    expect(term.open).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenLastCalledWith('SNAP');
  });

  it('disposes the xterm instance on unmount', () => {
    const { unmount } = render(
      <MainTerminal
        activeCardId="card-1"
        messages={[snapshotMessage('card-1', 1, 'SNAP')]}
      />,
    );

    const term = xtermMock.instances[0];
    expect(term.dispose).not.toHaveBeenCalled();

    unmount();

    expect(term.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps the xterm host mounted and shows an empty overlay when no card is active', () => {
    const { container } = render(
      <MainTerminal activeCardId={null} messages={[]} />,
    );

    // Root cause 2 fix: the host div is ALWAYS rendered so hostRef is stable
    // and the create-effect reliably builds the terminal exactly once. The
    // empty state is an overlay sibling, not an early-return replacement.
    expect(container.querySelector('.terminal-xterm-host')).not.toBeNull();
    expect(container.querySelector('.terminal-empty-overlay')).not.toBeNull();
    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
  });

  it('forces a redraw after applying a snapshot so the first frame is not black', () => {
    render(
      <MainTerminal
        activeCardId="card-1"
        messages={[
          snapshotMessage('card-1', 1, 'SNAP'),
          outputMessage('card-1', 2, 'OUT'),
        ]}
      />,
    );

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

  it('writes the snapshot after activeCardId goes null -> non-null without remount or mode change (root cause 2)', () => {
    const { rerender } = render(
      <MainTerminal activeCardId={null} messages={[]} />,
    );

    // Terminal is created up-front because the host is always mounted.
    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    const term = xtermMock.instances[0];
    expect(term.write).not.toHaveBeenCalled();

    // Card becomes active later (no remount, no mode change). The already
    // created terminal must receive the snapshot.
    rerender(
      <MainTerminal
        activeCardId="card-1"
        messages={[snapshotMessage('card-1', 1, 'SNAP')]}
      />,
    );

    // Same single instance — not recreated.
    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(term.reset).toHaveBeenCalled();
    expect(term.write).toHaveBeenLastCalledWith('SNAP');
  });

  it('reports fitted dimensions through onResize after layout settles', async () => {
    const onResize = vi.fn();
    render(
      <MainTerminal
        activeCardId="card-1"
        messages={[snapshotMessage('card-1', 1, 'SNAP')]}
        onResize={onResize}
      />,
    );

    // Root cause 3 fix: the initial fit is deferred via double rAF so a
    // not-yet-laid-out flex container is not measured. The resize is reported
    // once the deferred fit runs, not synchronously on mount.
    await vi.waitFor(() => {
      expect(onResize).toHaveBeenCalledWith(80, 24);
    });
  });

  it('coalesces visualViewport refits and does not report unchanged dimensions', async () => {
    const handlers: Record<string, Array<(event: Event) => void>> = {};
    const originalVisualViewport = window.visualViewport;
    const animationFrames: FrameRequestCallback[] = [];
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    const flushAnimationFrame = () => {
      const frame = animationFrames.shift();
      if (!frame) throw new Error('Expected a scheduled animation frame');
      frame(performance.now());
    };
    const visualViewport = {
      addEventListener: vi.fn((type: string, handler: (event: Event) => void) => {
        handlers[type] ??= [];
        handlers[type].push(handler);
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

    try {
      const onResize = vi.fn();
      const { unmount } = render(
        <MainTerminal
          activeCardId="card-1"
          messages={[snapshotMessage('card-1', 1, 'SNAP')]}
          onResize={onResize}
        />,
      );

      flushAnimationFrame();
      flushAnimationFrame();
      flushAnimationFrame();
      await vi.waitFor(() => {
        expect(onResize).toHaveBeenCalledWith(80, 24);
      });

      const term = xtermMock.instances[0];
      const fitAddon = term.loadAddon.mock.calls[0][0] as {
        fit: ReturnType<typeof vi.fn>;
      };
      fitAddon.fit.mockClear();
      onResize.mockClear();
      handlers.resize?.[0]?.(new Event('resize'));
      handlers.scroll?.[0]?.(new Event('scroll'));
      expect(animationFrames).toHaveLength(1);
      flushAnimationFrame();
      expect(fitAddon.fit).toHaveBeenCalledTimes(1);
      expect(onResize).not.toHaveBeenCalled();

      unmount();
      expect(visualViewport.removeEventListener).toHaveBeenCalledWith('resize', handlers.resize[0]);
      expect(visualViewport.removeEventListener).toHaveBeenCalledWith('scroll', handlers.scroll[0]);
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
    }
  });
});
