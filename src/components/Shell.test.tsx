/**
 * Shell.jsx behavioural tests (audit Stage 1).
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

vi.mock('../contexts/ThemeContext', () => ({
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
    ack: vi.fn(async () => {}),
    attachSnapshot: vi.fn(async () => null),
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

vi.mock('../lib/tauri-bridge', () => ({
  isTauriEnv: () => ptyMock.isTauri.value,
  invoke: vi.fn(),
  pty: {
    create: ptyMock.create,
    getSessionState: ptyMock.getSessionState,
    input: ptyMock.input,
    resize: ptyMock.resize,
    kill: ptyMock.kill,
    ack: ptyMock.ack,
    attachSnapshot: ptyMock.attachSnapshot,
    onOutput: ptyMock.onOutput,
    onExit: ptyMock.onExit,
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import Shell from './Shell';

const PROJECT = { name: 'proj', path: '/tmp/proj', fullPath: '/tmp/proj' };

function renderMinimalShell(paneId = 'pane-1') {
  return render(
    <Shell
      selectedProject={PROJECT}
      initialCommand={undefined}
      minimal={true}
      autoConnect={true}
      paneId={paneId}
      active={true}
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
});
