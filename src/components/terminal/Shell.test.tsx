/**
 * Shell.tsx behavioural tests (audit Stage 1).
 *
 * Covers the three P0/P1 fixes:
 *   • P1-2 — PTY exit appends a banner (no screen wipe) and blocks the silent
 *     auto-respawn until the user clicks "Restart session".
 *   • P1-4 — connection failures in minimal mode surface a reconnect strip
 *     instead of a black screen.
 *   • P0-1 — the scroll-to-bottom indicator appears when the user scrolls up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PtyAttachSnapshot } from '../../lib/tauri-bridge';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && 'defaultValue' in opts) return opts.defaultValue as string;
        return key;
      },
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

vi.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    terminalTheme: { background: '#000000' },
    activeThemeTokens: { terminal: { background: '#000000', foreground: '#ffffff' } },
  }),
}));

const xtermMock = vi.hoisted(() => {
  const instances: MockTerminal[] = [];

  class MockTerminal {
    options: Record<string, unknown>;
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0 } };
    rows = 24;
    cols = 80;
    scrollHandlers: Array<() => void> = [];
    write = vi.fn((_data: string, cb?: () => void) => {
      cb?.();
    });
    clear = vi.fn();
    open = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    refresh = vi.fn();
    focus = vi.fn();
    resize = vi.fn();
    scrollToBottom = vi.fn();
    hasSelection = vi.fn(() => false);
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onScroll = vi.fn((cb: () => void) => {
      this.scrollHandlers.push(cb);
      return { dispose: vi.fn() };
    });

    constructor(options: Record<string, unknown>) {
      this.options = options;
      instances.push(this);
    }
  }

  return { Terminal: MockTerminal, instances };
});

type MockTerminal = InstanceType<typeof xtermMock.Terminal>;

vi.mock('@xterm/xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function FitAddon(this: { fit: ReturnType<typeof vi.fn> }) {
    this.fit = vi.fn();
  }),
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(function WebLinksAddon() {}),
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(function WebglAddon(this: {
    onContextLoss: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }) {
    this.onContextLoss = vi.fn();
    this.dispose = vi.fn();
  }),
}));

const ptyMock = vi.hoisted(() => {
  const exitHandlers = new Set<(payload: { id: string; code?: number | null }) => void>();
  const outputHandlers = new Set<(payload: { id: string; data: string; seq: number }) => void>();
  return {
    isTauri: { value: true },
    exitHandlers,
    outputHandlers,
    create: vi.fn(async (id: string) => id),
    getSessionState: vi.fn(async () => {
      throw new Error('no session');
    }),
    input: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    registerOutputConsumer: vi.fn(async (_id: string, _consumerId: string) => {}),
    unregisterOutputConsumer: vi.fn(async (_id: string, _consumerId: string) => {}),
    ack: vi.fn(async () => {}),
    attachSnapshot: vi.fn<(_id: string) => Promise<PtyAttachSnapshot | null>>(
      async () => null,
    ),
    onOutput: vi.fn(async (cb: (payload: { id: string; data: string; seq: number }) => void) => {
      outputHandlers.add(cb);
      return () => outputHandlers.delete(cb);
    }),
    onExit: vi.fn(async (cb: (payload: { id: string; code?: number | null }) => void) => {
      exitHandlers.add(cb);
      return () => exitHandlers.delete(cb);
    }),
  };
});

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => ptyMock.isTauri.value,
  invoke: vi.fn(),
  pty: {
    create: ptyMock.create,
    getSessionState: ptyMock.getSessionState,
    input: ptyMock.input,
    resize: ptyMock.resize,
    kill: ptyMock.kill,
    registerOutputConsumer: ptyMock.registerOutputConsumer,
    unregisterOutputConsumer: ptyMock.unregisterOutputConsumer,
    ack: ptyMock.ack,
    attachSnapshot: ptyMock.attachSnapshot,
    onOutput: ptyMock.onOutput,
    onExit: ptyMock.onExit,
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import Shell from './Shell';
import {
  TERMINAL_GEOMETRY_INVALIDATED_EVENT,
  TERMINAL_SURFACE_SHOWN_EVENT,
} from './terminalSurfaceEvents';

const PROJECT = { name: 'proj', path: '/tmp/proj', fullPath: '/tmp/proj' };

function renderMinimalShell(
  paneId = 'pane-1',
  active = true,
  initialCommand?: string,
  rendererScope = 'main',
) {
  return render(
    <Shell
      selectedProject={PROJECT}
      initialCommand={initialCommand}
      minimal={true}
      autoConnect={true}
      paneId={paneId}
      active={active}
      rendererScope={rendererScope}
      preservePtyOnUnmount={true}
      autoReconnectOnExit={false}
      onDisconnect={undefined}
      onInitialCommandSent={undefined}
      onUserSubmit={undefined}
    />,
  );
}

async function waitForConnected() {
  await waitFor(() => {
    expect(ptyMock.create).toHaveBeenCalled();
    expect(ptyMock.exitHandlers.size).toBeGreaterThan(0);
  });
}

function emitExit(payload: { id: string; code?: number | null }) {
  for (const handler of ptyMock.exitHandlers) handler(payload);
}

function renderShellProps(
  paneId: string,
  initialCommand?: string,
  active = true,
  rendererScope = 'main',
) {
  return (
    <Shell
      selectedProject={PROJECT}
      initialCommand={initialCommand}
      minimal={true}
      autoConnect={true}
      paneId={paneId}
      active={active}
      rendererScope={rendererScope}
      preservePtyOnUnmount={true}
      autoReconnectOnExit={false}
      onDisconnect={undefined}
      onInitialCommandSent={undefined}
      onUserSubmit={undefined}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  ptyMock.isTauri.value = true;
  ptyMock.exitHandlers.clear();
  ptyMock.outputHandlers.clear();
  xtermMock.instances.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Shell — exit handling (P1-2)', () => {
  it('appends an exit banner without clearing the screen and shows the exit strip', async () => {
    renderMinimalShell();
    await waitForConnected();

    const term = xtermMock.instances[0];
    term.clear.mockClear();

    act(() => {
      emitExit({ id: 'pane-1', code: 1 });
    });

    const banner = term.write.mock.calls
      .map((call) => call[0] as string)
      .find((data) => data.includes('shell.exitBannerCode'));
    expect(banner).toBeDefined();
    expect(banner).toContain('\x1b[31m'); // red — non-zero exit
    expect(term.clear).not.toHaveBeenCalled();
    expect(await screen.findByTestId('shell-exit-strip')).toBeInTheDocument();
  });

  it('does not auto-respawn after exit until the user clicks restart', async () => {
    renderMinimalShell();
    await waitForConnected();
    expect(ptyMock.create).toHaveBeenCalledTimes(1);

    act(() => {
      emitExit({ id: 'pane-1', code: 0 });
    });
    await screen.findByTestId('shell-exit-strip');

    // The autoConnect effect re-ran on the isConnected flip; the exit gate
    // must have blocked the silent respawn.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ptyMock.create).toHaveBeenCalledTimes(1);

    const term = xtermMock.instances[0];
    fireEvent.click(screen.getByText('shell.restartSession'));
    expect(term.clear).toHaveBeenCalled();
    await waitFor(() => expect(ptyMock.create).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByTestId('shell-exit-strip')).not.toBeInTheDocument(),
    );
  });

  it('ignores exits from other panes', async () => {
    renderMinimalShell();
    await waitForConnected();

    act(() => {
      emitExit({ id: 'other-pane', code: 1 });
    });
    expect(screen.queryByTestId('shell-exit-strip')).not.toBeInTheDocument();
  });
});

describe('Shell — connection failure surfacing (P1-4)', () => {
  it('shows the reconnect strip with the error when the PTY cannot be created', async () => {
    ptyMock.isTauri.value = false; // connectPty throws shell.ptyDesktopOnly

    renderMinimalShell();

    const strip = await screen.findByTestId('shell-reconnect-strip');
    expect(strip).toHaveTextContent('shell.connectionError');
    expect(screen.getByText('shell.retryNow')).toBeInTheDocument();
  });

  it('retry button reconnects immediately and clears the strip on success', async () => {
    ptyMock.isTauri.value = false;
    renderMinimalShell();
    await screen.findByTestId('shell-reconnect-strip');

    ptyMock.isTauri.value = true;
    fireEvent.click(screen.getByText('shell.retryNow'));

    await waitFor(() => expect(ptyMock.create).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId('shell-reconnect-strip')).not.toBeInTheDocument(),
    );
  });

  it('unregisters the renderer and reports failure when snapshot attach rejects', async () => {
    ptyMock.attachSnapshot.mockRejectedValueOnce(new Error('snapshot IPC failed'));

    renderMinimalShell();

    expect(await screen.findByTestId('shell-reconnect-strip')).toBeInTheDocument();
    const [ptyId, consumerId] = ptyMock.registerOutputConsumer.mock.calls[0];
    await waitFor(() => {
      expect(ptyMock.unregisterOutputConsumer).toHaveBeenCalledWith(ptyId, consumerId);
    });
    expect(ptyMock.ack).not.toHaveBeenCalled();
  });
});

describe('Shell — pane switching', () => {
  it('detaches the old PTY and connects the new pane without killing the old session', async () => {
    const { rerender } = renderMinimalShell('pane-1', true, 'first');
    await waitForConnected();
    await waitFor(() => expect(ptyMock.input).toHaveBeenCalledWith('pane-1', 'first\r'));
    const oldOutputHandler = Array.from(ptyMock.outputHandlers)[0];
    const term = xtermMock.instances[0];
    term.write.mockClear();

    rerender(renderShellProps('pane-2', 'second'));

    await waitFor(() => expect(ptyMock.create).toHaveBeenCalledWith('pane-2', '/tmp/proj', 24, 80));
    await waitFor(() => expect(ptyMock.input).toHaveBeenCalledWith('pane-2', 'second\r'));
    expect(ptyMock.kill).not.toHaveBeenCalled();

    act(() => {
      oldOutputHandler?.({ id: 'pane-1', data: 'old output', seq: 1 });
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-2', data: 'new output', seq: 1 });
      }
    });

    expect(term.write).not.toHaveBeenCalledWith('old output', expect.any(Function));
    expect(term.write).toHaveBeenCalledWith('new output', expect.any(Function));
    await waitFor(() =>
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-2',
        1,
        'renderer',
        expect.any(String),
      ),
    );
  });

  it('ignores a stale connect that resolves after the pane changed', async () => {
    let resolveFirstCreate: ((id: string) => void) | null = null;
    ptyMock.create
      .mockImplementationOnce(
        (id: string) =>
          new Promise<string>((resolve) => {
            resolveFirstCreate = () => resolve(id);
          }),
      )
      .mockImplementationOnce(async (id: string) => id);

    const { rerender } = renderMinimalShell('pane-1', true, 'first');
    await waitFor(() => expect(ptyMock.create).toHaveBeenCalledWith('pane-1', '/tmp/proj', 24, 80));

    rerender(renderShellProps('pane-2', 'second'));
    act(() => {
      resolveFirstCreate?.('pane-1');
    });

    await waitFor(() => expect(ptyMock.create).toHaveBeenCalledWith('pane-2', '/tmp/proj', 24, 80));
    await waitFor(() => expect(ptyMock.input).toHaveBeenCalledWith('pane-2', 'second\r'));
    expect(ptyMock.input).not.toHaveBeenCalledWith('pane-1', 'first\r');
  });

  it('does not let a stale listener setup dispose the new pane consumer', async () => {
    let resolveFirstOutputListener: (() => void) | undefined;
    ptyMock.onOutput.mockImplementationOnce(
      (callback: (payload: { id: string; data: string; seq: number }) => void) => {
        ptyMock.outputHandlers.add(callback);
        return new Promise<() => boolean>((resolve) => {
          resolveFirstOutputListener = () =>
            resolve(() => ptyMock.outputHandlers.delete(callback));
        });
      },
    );

    const { rerender } = renderMinimalShell('pane-1');
    await waitFor(() => {
      expect(ptyMock.registerOutputConsumer).toHaveBeenCalledWith(
        'pane-1',
        expect.any(String),
      );
      expect(ptyMock.onOutput).toHaveBeenCalledTimes(1);
    });

    rerender(renderShellProps('pane-2'));
    await waitFor(() => {
      expect(ptyMock.registerOutputConsumer).toHaveBeenCalledWith(
        'pane-2',
        expect.any(String),
      );
      expect(ptyMock.exitHandlers.size).toBeGreaterThan(0);
    });
    const pane2ConsumerId = ptyMock.registerOutputConsumer.mock.calls.find(
      ([id]) => id === 'pane-2',
    )?.[1];

    act(() => resolveFirstOutputListener?.());
    await waitFor(() => {
      expect(ptyMock.unregisterOutputConsumer).not.toHaveBeenCalledWith(
        'pane-2',
        pane2ConsumerId,
      );
    });

    ptyMock.ack.mockClear();
    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-2', data: 'still-live', seq: 9 });
      }
    });
    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-2',
        9,
        'renderer',
        pane2ConsumerId,
      );
    });
  });
});

describe('Shell — PTY output consumer lifecycle', () => {
  it('registers a unique renderer consumer and unregisters it on unmount', async () => {
    const { unmount } = renderMinimalShell();
    await waitForConnected();

    const [, consumerId] = ptyMock.registerOutputConsumer.mock.calls[0];
    expect(consumerId).toMatch(/^renderer:main:/);
    expect(ptyMock.registerOutputConsumer).toHaveBeenCalledWith(
      'pane-1',
      expect.any(String),
    );

    unmount();
    await waitFor(() => {
      expect(ptyMock.unregisterOutputConsumer).toHaveBeenCalledWith(
        'pane-1',
        consumerId,
      );
    });
  });

  it('acks renderer output only after xterm reports the write drained', async () => {
    renderMinimalShell();
    await waitForConnected();
    const term = xtermMock.instances[0];
    let drainWrite: (() => void) | undefined;
    term.write.mockImplementationOnce((_data: string, callback?: () => void) => {
      drainWrite = callback;
    });
    ptyMock.ack.mockClear();

    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-1', data: 'render me', seq: 5 });
      }
    });
    expect(ptyMock.ack).not.toHaveBeenCalled();

    act(() => drainWrite?.());
    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-1',
        5,
        'renderer',
        expect.any(String),
      );
    });
  });

  it('preserves synchronized ED2/ED3 frames without stalling renderer acknowledgements', async () => {
    renderMinimalShell();
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-1'));
    const term = xtermMock.instances[0];
    expect(term.options.scrollOnEraseInDisplay).toBe(false);
    term.write.mockClear();
    ptyMock.ack.mockClear();

    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-1', data: '\x1b[?2026hframe', seq: 1 });
        handler({ id: 'pane-1', data: '\x1b[2J\x1b[3J', seq: 2 });
        handler({ id: 'pane-1', data: 'done\x1b[?2026l\x1b[2J', seq: 3 });
      }
    });

    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-1',
        3,
        'renderer',
        expect.any(String),
      );
    });
    expect(term.write.mock.calls.map(([data]) => data).join('')).toBe(
      '\x1b[?2026hframe\x1b[2J\x1b[3Jdone\x1b[?2026l\x1b[2J',
    );
  });

  it('uses a float-scoped consumer and restores its lease immediately when reactivated', async () => {
    const { rerender } = renderMinimalShell('pane-float', false, undefined, 'float');
    await waitForConnected();
    await waitFor(() => {
      expect(ptyMock.registerOutputConsumer).toHaveBeenCalledWith(
        'pane-float',
        expect.stringMatching(/^renderer:float:/),
      );
    });

    const [, consumerId] = ptyMock.registerOutputConsumer.mock.calls[0];
    ptyMock.registerOutputConsumer.mockClear();
    ptyMock.attachSnapshot.mockClear();
    ptyMock.ack.mockClear();

    rerender(renderShellProps('pane-float', undefined, true, 'float'));

    await waitFor(() => {
      expect(ptyMock.registerOutputConsumer).toHaveBeenCalledWith('pane-float', consumerId);
    });
    expect(ptyMock.attachSnapshot).not.toHaveBeenCalled();
    expect(ptyMock.ack).not.toHaveBeenCalled();
  });

  it('does not keep renewing a renderer lease while the whole window is hidden', async () => {
    let visibilityState: DocumentVisibilityState = 'visible';
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState);
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const { unmount } = renderMinimalShell('pane-background');

    try {
      await waitForConnected();
      const heartbeatHandler = intervalSpy.mock.calls.find(
        ([, delay]) => delay === 5_000,
      )?.[0];
      const heartbeat =
        typeof heartbeatHandler === 'function' ? heartbeatHandler : undefined;
      expect(heartbeat).toBeDefined();
      ptyMock.registerOutputConsumer.mockClear();

      visibilityState = 'hidden';
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        heartbeat?.();
      });

      expect(ptyMock.registerOutputConsumer).not.toHaveBeenCalled();
    } finally {
      unmount();
      intervalSpy.mockRestore();
      visibilitySpy.mockRestore();
    }
  });

  it('restores the current terminal screen after the whole window was hidden past its lease', async () => {
    let visibilityState: DocumentVisibilityState = 'visible';
    let now = 1_000;
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { unmount } = renderMinimalShell('pane-long-background');

    try {
      await waitForConnected();
      await waitFor(() =>
        expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-long-background'),
      );
      const term = xtermMock.instances[0];
      term.clear.mockClear();
      term.write.mockClear();
      term.resize.mockClear();
      ptyMock.attachSnapshot.mockClear();
      ptyMock.registerOutputConsumer.mockClear();
      ptyMock.ack.mockClear();

      visibilityState = 'hidden';
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      now += 30_000;
      ptyMock.attachSnapshot.mockResolvedValueOnce({
        ptyId: 'pane-long-background',
        data: 'current screen',
        history: 'recent history\n',
        seq: 19,
        rows: 32,
        cols: 104,
        cursorRow: 4,
        cursorCol: 7,
      });

      visibilityState = 'visible';
      act(() => document.dispatchEvent(new Event('visibilitychange')));

      await waitFor(() => {
        expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-long-background');
        expect(term.clear).toHaveBeenCalledTimes(1);
        expect(term.resize).toHaveBeenCalledWith(104, 32);
        expect(term.write).toHaveBeenCalledWith(
          'recent history\ncurrent screen',
          expect.any(Function),
        );
      });
      await waitFor(() => {
        expect(ptyMock.ack).toHaveBeenCalledWith(
          'pane-long-background',
          19,
          'renderer',
          expect.any(String),
        );
      });
    } finally {
      unmount();
      nowSpy.mockRestore();
      visibilitySpy.mockRestore();
    }
  });
});

describe('Shell — scroll-to-bottom indicator (P0-1)', () => {
  it('appears when the viewport leaves the bottom and scrolls back on click', async () => {
    renderMinimalShell();
    await waitForConnected();

    const term = xtermMock.instances[0];
    term.buffer.active.baseY = 100;
    term.buffer.active.viewportY = 40; // scrolled up

    act(() => {
      for (const handler of term.scrollHandlers) handler();
    });

    const indicator = await screen.findByTestId('shell-scroll-to-bottom');
    fireEvent.click(indicator);
    expect(term.scrollToBottom).toHaveBeenCalled();

    // Returning to the bottom hides the indicator.
    term.buffer.active.viewportY = 100;
    act(() => {
      for (const handler of term.scrollHandlers) handler();
    });
    await waitFor(() =>
      expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument(),
    );
  });

  it('does not repeat a programmatic scroll while live output already follows the bottom', async () => {
    renderMinimalShell('pane-live-bottom');
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-live-bottom'));

    const term = xtermMock.instances[0];
    term.buffer.active.baseY = 100;
    term.buffer.active.viewportY = 100;
    term.write.mockClear();
    term.scrollToBottom.mockClear();
    ptyMock.ack.mockClear();

    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-live-bottom', data: 'resumed output\n', seq: 1 });
      }
    });

    expect(term.write).toHaveBeenCalledWith('resumed output\n', expect.any(Function));
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-live-bottom',
        1,
        'renderer',
        expect.any(String),
      );
    });
  });

  it('scrolls to the bottom when the terminal becomes active', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      top: 0,
      left: 0,
      right: 640,
      bottom: 360,
      toJSON: () => ({}),
    } as DOMRect);
    try {
      const { rerender } = render(
        <Shell
          selectedProject={PROJECT}
          initialCommand={undefined}
          minimal={true}
          autoConnect={true}
          paneId="pane-active"
          active={false}
          preservePtyOnUnmount={true}
          autoReconnectOnExit={false}
          onDisconnect={undefined}
          onInitialCommandSent={undefined}
          onUserSubmit={undefined}
        />,
      );
      await waitForConnected();

      const term = xtermMock.instances[0];
      term.buffer.active.baseY = 100;
      term.buffer.active.viewportY = 40;
      act(() => {
        for (const handler of term.scrollHandlers) handler();
      });
      // Hidden terminals intentionally avoid DOM/React display effects. The
      // active transition below performs the authoritative viewport recovery.
      expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument();

      term.scrollToBottom.mockClear();

      rerender(
        <Shell
          selectedProject={PROJECT}
          initialCommand={undefined}
          minimal={true}
          autoConnect={true}
          paneId="pane-active"
          active={true}
          preservePtyOnUnmount={true}
          autoReconnectOnExit={false}
          onDisconnect={undefined}
          onInitialCommandSent={undefined}
          onUserSubmit={undefined}
        />,
      );

      await waitFor(() => expect(term.scrollToBottom).toHaveBeenCalled());
      await waitFor(() =>
        expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument(),
      );
    } finally {
      rectSpy.mockRestore();
    }
  });

});

describe('Shell — Windows surface recovery and hidden rendering (O-04 / C-03p)', () => {
  function fitAddonFor(term: MockTerminal) {
    return term.loadAddon.mock.calls[0]?.[0] as
      | { fit: ReturnType<typeof vi.fn> }
      | undefined;
  }

  function installManualSurfaceScheduler() {
    let nextHandle = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const timeouts = new Map<number, { delay: number; callback: () => void }>();

    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    });
    const cancelFrame = vi.fn((handle: number) => {
      frames.delete(handle);
    });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);

    const clearScheduledTimeout = vi.fn((handle: Parameters<typeof clearTimeout>[0]) => {
      if (typeof handle === 'number') timeouts.delete(handle);
    });
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation((
      handler: (_: void) => void,
      timeout?: number,
    ) => {
      const handle = nextHandle++;
      timeouts.set(handle, {
        delay: Number(timeout ?? 0),
        callback: () => handler(),
      });
      return handle as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi
      .spyOn(window, 'clearTimeout')
      .mockImplementation(clearScheduledTimeout);
    vi.stubGlobal('clearTimeout', clearScheduledTimeout);

    return {
      frames,
      timeouts,
      requestFrame,
      runNextFrame() {
        const entry = frames.entries().next().value as
          | [number, FrameRequestCallback]
          | undefined;
        if (!entry) throw new Error('expected a queued animation frame');
        const [handle, callback] = entry;
        frames.delete(handle);
        act(() => callback(0));
      },
      runTimeout(delay: number) {
        const entry = Array.from(timeouts.entries()).find(([, timer]) => timer.delay === delay);
        if (!entry) throw new Error(`expected a queued ${delay}ms timeout`);
        const [handle, timer] = entry;
        timeouts.delete(handle);
        act(() => timer.callback());
      },
      restore() {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      },
    };
  }

  function installGeometry(width: number, height: number) {
    const geometry = { width, height };
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 0,
      width: geometry.width,
      height: geometry.height,
      top: 0,
      left: 0,
      right: geometry.width,
      bottom: geometry.height,
      toJSON: () => ({}),
    } as DOMRect));
    return { geometry, spy };
  }

  it('uses ordinary pointer clicks only to focus, without a full surface recovery', async () => {
    const view = renderMinimalShell('pane-focus-only');
    await waitForConnected();
    const term = xtermMock.instances[0];
    const fitAddon = fitAddonFor(term);
    term.focus.mockClear();
    fitAddon?.fit.mockClear();
    ptyMock.resize.mockClear();

    fireEvent.mouseDown(view.container.firstElementChild as Element);

    expect(term.focus).toHaveBeenCalledTimes(1);
    expect(fitAddon?.fit).not.toHaveBeenCalled();
    expect(ptyMock.resize).not.toHaveBeenCalled();
  });

  it('reasserts shared PTY geometry once after another renderer invalidates the local cache', async () => {
    const { spy: rectSpy } = installGeometry(800, 600);
    const { unmount } = renderMinimalShell('pane-shared-geometry');
    await waitForConnected();
    await waitFor(() => expect(ptyMock.resize).toHaveBeenCalled());

    const term = xtermMock.instances[0];
    term.focus.mockClear();
    term.scrollToBottom.mockClear();
    ptyMock.resize.mockClear();
    const scheduler = installManualSurfaceScheduler();

    try {
      // An invalidation for another PTY must not defeat this Shell's local
      // resize dedupe cache.
      act(() => {
        window.dispatchEvent(new CustomEvent(TERMINAL_GEOMETRY_INVALIDATED_EVENT, {
          detail: { ptyId: 'another-pane' },
        }));
        window.dispatchEvent(new CustomEvent(TERMINAL_SURFACE_SHOWN_EVENT, {
          detail: { focus: false },
        }));
      });
      scheduler.runNextFrame();
      expect(ptyMock.resize).not.toHaveBeenCalled();

      // The matching invalidation means the float renderer may have changed
      // the backend geometry even though this xterm stayed at 24x80.
      act(() => {
        window.dispatchEvent(new CustomEvent(TERMINAL_GEOMETRY_INVALIDATED_EVENT, {
          detail: { ptyId: 'pane-shared-geometry' },
        }));
        window.dispatchEvent(new CustomEvent(TERMINAL_SURFACE_SHOWN_EVENT, {
          detail: { focus: false },
        }));
      });
      scheduler.runNextFrame();

      expect(ptyMock.resize).toHaveBeenCalledTimes(1);
      expect(ptyMock.resize).toHaveBeenCalledWith('pane-shared-geometry', 24, 80);
      expect(term.focus).not.toHaveBeenCalled();
      expect(term.scrollToBottom).not.toHaveBeenCalled();
      expect(scheduler.timeouts).toHaveLength(0);
    } finally {
      unmount();
      scheduler.restore();
      rectSpy.mockRestore();
    }
  });

  it('recovers from 0x0 once and does not repeat geometry, resize, scroll, or refresh work', async () => {
    const { geometry, spy: rectSpy } = installGeometry(0, 0);
    const { rerender, unmount } = render(renderShellProps('pane-recovery', undefined, false));
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-recovery'));

    const term = xtermMock.instances[0];
    const fitAddon = fitAddonFor(term);
    expect(fitAddon).toBeDefined();
    fitAddon?.fit.mockClear();
    term.refresh.mockClear();
    term.focus.mockClear();
    term.scrollToBottom.mockClear();
    ptyMock.resize.mockClear();

    const scheduler = installManualSurfaceScheduler();
    try {
      rerender(renderShellProps('pane-recovery', undefined, true));
      expect(scheduler.frames).toHaveLength(1);
      expect(scheduler.timeouts).toHaveLength(4);
      const themeRefreshCount = term.refresh.mock.calls.length;

      // The first frame still sees Windows WebView2's transient zero-sized host.
      scheduler.runNextFrame();
      expect(fitAddon?.fit).not.toHaveBeenCalled();
      expect(ptyMock.resize).not.toHaveBeenCalled();
      expect(term.refresh).toHaveBeenCalledTimes(themeRefreshCount);

      geometry.width = 800;
      geometry.height = 600;
      scheduler.runTimeout(60);

      expect(fitAddon?.fit).toHaveBeenCalledTimes(1);
      expect(ptyMock.resize).toHaveBeenCalledTimes(1);
      expect(ptyMock.resize).toHaveBeenCalledWith('pane-recovery', 24, 80);
      expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(term.refresh).toHaveBeenCalledTimes(themeRefreshCount + 1);

      // Later focus retries may run, but geometry/viewport work is settled.
      scheduler.runTimeout(180);
      scheduler.runTimeout(400);
      scheduler.runTimeout(800);
      expect(fitAddon?.fit).toHaveBeenCalledTimes(1);
      expect(ptyMock.resize).toHaveBeenCalledTimes(1);
      expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(term.refresh).toHaveBeenCalledTimes(themeRefreshCount + 1);
    } finally {
      unmount();
      scheduler.restore();
      rectSpy.mockRestore();
    }
  });

  it('cancels pending recovery generations when inactive and on unmount', async () => {
    const { spy: rectSpy } = installGeometry(0, 0);
    const { rerender, unmount } = render(renderShellProps('pane-cancel', undefined, false));
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-cancel'));

    const term = xtermMock.instances[0];
    const fitAddon = fitAddonFor(term);
    fitAddon?.fit.mockClear();
    term.focus.mockClear();
    term.scrollToBottom.mockClear();
    const scheduler = installManualSurfaceScheduler();

    try {
      rerender(renderShellProps('pane-cancel', undefined, true));
      expect(scheduler.frames).toHaveLength(1);
      expect(scheduler.timeouts).toHaveLength(4);

      rerender(renderShellProps('pane-cancel', undefined, false));
      expect(scheduler.frames).toHaveLength(0);
      expect(scheduler.timeouts).toHaveLength(0);
      expect(fitAddon?.fit).not.toHaveBeenCalled();
      expect(term.focus).not.toHaveBeenCalled();
      expect(term.scrollToBottom).not.toHaveBeenCalled();

      rerender(renderShellProps('pane-cancel', undefined, true));
      expect(scheduler.frames).toHaveLength(1);
      expect(scheduler.timeouts).toHaveLength(4);
      unmount();
      expect(scheduler.frames).toHaveLength(0);
      expect(scheduler.timeouts).toHaveLength(0);
      expect(fitAddon?.fit).not.toHaveBeenCalled();
      expect(term.focus).not.toHaveBeenCalled();
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    } finally {
      scheduler.restore();
      rectSpy.mockRestore();
    }
  });

  it('coalesces 100 carriage-return chunks into one refresh in the same frame', async () => {
    renderMinimalShell('pane-cr');
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-cr'));

    const term = xtermMock.instances[0];
    term.refresh.mockClear();
    ptyMock.ack.mockClear();
    const scheduler = installManualSurfaceScheduler();

    try {
      act(() => {
        for (let seq = 1; seq <= 100; seq += 1) {
          for (const handler of ptyMock.outputHandlers) {
            handler({ id: 'pane-cr', data: `progress ${seq}\r`, seq });
          }
        }
      });

      expect(term.write).toHaveBeenCalledTimes(100);
      expect(term.refresh).not.toHaveBeenCalled();
      expect(scheduler.requestFrame).toHaveBeenCalledTimes(1);
      expect(scheduler.frames).toHaveLength(1);

      scheduler.runNextFrame();
      expect(term.refresh).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.restore();
    }

    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenLastCalledWith(
        'pane-cr',
        100,
        'renderer',
        expect.any(String),
      );
    });
  });

  it('keeps hidden xterm writes and drain ACKs but suppresses display effects until reactivated', async () => {
    const { rerender, container } = render(renderShellProps('pane-hidden', undefined, false));
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-hidden'));

    const term = xtermMock.instances[0];
    const fitAddon = fitAddonFor(term);
    const host = container.querySelector('.threadterm-xterm-host');
    expect(host).not.toBeNull();
    const querySelectorSpy = vi.spyOn(host as HTMLElement, 'querySelector');
    term.buffer.active.baseY = 100;
    term.buffer.active.viewportY = 40;
    term.refresh.mockClear();
    term.scrollToBottom.mockClear();
    ptyMock.ack.mockClear();

    let drainWrite: (() => void) | undefined;
    term.write.mockImplementationOnce((_data: string, callback?: () => void) => {
      drainWrite = callback;
    });

    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-hidden', data: 'hidden progress\rhidden done\n', seq: 7 });
      }
    });

    expect(term.write).toHaveBeenCalledWith(
      'hidden progress\rhidden done\n',
      expect.any(Function),
    );
    expect(ptyMock.ack).not.toHaveBeenCalled();
    expect(querySelectorSpy).not.toHaveBeenCalled();
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(term.refresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument();

    act(() => drainWrite?.());
    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-hidden',
        7,
        'renderer',
        expect.any(String),
      );
    });
    expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument();

    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      toJSON: () => ({}),
    } as DOMRect);
    fitAddon?.fit.mockClear();
    term.focus.mockClear();
    term.scrollToBottom.mockClear();
    term.refresh.mockClear();

    try {
      rerender(renderShellProps('pane-hidden', undefined, true));
      const themeRefreshCount = term.refresh.mock.calls.length;
      await waitFor(() => expect(fitAddon?.fit).toHaveBeenCalledTimes(1));
      expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(term.refresh).toHaveBeenCalledTimes(themeRefreshCount + 1);
      expect(term.focus).toHaveBeenCalled();
      expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument();
    } finally {
      rectSpy.mockRestore();
      querySelectorSpy.mockRestore();
    }
  });
});
