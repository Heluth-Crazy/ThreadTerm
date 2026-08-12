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
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
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
    dataHandlers = new Set<(data: string) => void>();
    onData = vi.fn((cb: (data: string) => void) => {
      this.dataHandlers.add(cb);
      return { dispose: () => this.dataHandlers.delete(cb) };
    });
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

export type MockTerminal = InstanceType<typeof xtermMock.Terminal>;

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

export const PROJECT = { name: 'proj', path: '/tmp/proj', fullPath: '/tmp/proj' };

export function renderMinimalShell(
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

export async function waitForConnected() {
  await waitFor(() => {
    expect(ptyMock.create).toHaveBeenCalled();
    expect(ptyMock.exitHandlers.size).toBeGreaterThan(0);
  });
}

export function emitExit(payload: { id: string; code?: number | null }) {
  for (const handler of ptyMock.exitHandlers) handler(payload);
}

export function renderShellProps(
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


export function getXtermMock() {
  return xtermMock;
}

export function getPtyMock() {
  return ptyMock;
}

export function TestShell(props: ComponentProps<typeof Shell>) {
  return <Shell {...props} />;
}
