import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => {
  const overlayState = {
    selectorOpen: false,
    selectorSurface: 'window',
    selectorMode: 'tile',
    selectorSelectedIndex: 0,
    floatOpen: false,
    floatCardId: null as string | null,
    floatHiddenByOverlay: false,
    lightweightMode: false,
    setSelectorMode: vi.fn(),
    setSelectedIndex: vi.fn(),
    openSelector: vi.fn(),
    closeSelector: vi.fn(),
    confirmSelector: vi.fn(),
    recycleToMain: vi.fn(),
    setHotkeys: vi.fn(),
  };
  const terminalState = {
    cards: [{ id: 'card-1', ptyId: 'pty-1' }],
    setPendingFocusCardId: vi.fn(),
    focusCard: vi.fn(),
  };
  return {
    listeners: new Map<string, Set<(event: { payload?: unknown }) => void>>(),
    listen: vi.fn(),
    invoke: vi.fn(async () => ({
      hotkey_a: 'CmdOrCtrl+Shift+Space',
      hotkey_b: 'CmdOrCtrl+Shift+O',
      lightweight_mode: false,
    })),
    overlayState,
    terminalState,
  };
});

vi.mock('@tauri-apps/api/event', () => ({ listen: bridgeMocks.listen }));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  invoke: bridgeMocks.invoke,
}));

vi.mock('../../stores/overlayStore', () => {
  const useOverlayStore = Object.assign(
    (selector: (state: typeof bridgeMocks.overlayState) => unknown) =>
      selector(bridgeMocks.overlayState),
    {
      getState: () => bridgeMocks.overlayState,
      setState: (patch: Partial<typeof bridgeMocks.overlayState>) => {
        Object.assign(bridgeMocks.overlayState, patch);
      },
    },
  );
  return { useOverlayStore };
});

vi.mock('../../stores/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector: (state: typeof bridgeMocks.terminalState) => unknown) =>
      selector(bridgeMocks.terminalState),
    { getState: () => bridgeMocks.terminalState },
  ),
}));

vi.mock('../../windows/selector/SelectorApp', () => ({
  SelectorSurface: () => null,
}));

import {
  TERMINAL_GEOMETRY_INVALIDATED_EVENT,
  TERMINAL_SURFACE_SHOWN_EVENT,
} from '../terminal/terminalSurfaceEvents';
import { OverlayBridge } from './OverlayBridge';

function emit(event: string, payload?: unknown) {
  for (const handler of bridgeMocks.listeners.get(event) ?? []) {
    handler({ payload });
  }
}

beforeEach(() => {
  bridgeMocks.listeners.clear();
  vi.clearAllMocks();
  Object.assign(bridgeMocks.overlayState, {
    selectorOpen: false,
    floatOpen: false,
    floatCardId: null,
    floatHiddenByOverlay: false,
    lightweightMode: false,
  });
  bridgeMocks.listen.mockImplementation(
    async (event: string, handler: (event: { payload?: unknown }) => void) => {
      const handlers = bridgeMocks.listeners.get(event) ?? new Set();
      handlers.add(handler);
      bridgeMocks.listeners.set(event, handlers);
      return () => handlers.delete(handler);
    },
  );
});

afterEach(cleanup);

describe('OverlayBridge shared PTY geometry hand-off', () => {
  it('invalidates the matching main Shell and recovers it without focus on float hide', async () => {
    const geometryEvents: CustomEvent[] = [];
    const surfaceEvents: CustomEvent[] = [];
    const onGeometry = (event: Event) => geometryEvents.push(event as CustomEvent);
    const onSurface = (event: Event) => surfaceEvents.push(event as CustomEvent);
    window.addEventListener(TERMINAL_GEOMETRY_INVALIDATED_EVENT, onGeometry);
    window.addEventListener(TERMINAL_SURFACE_SHOWN_EVENT, onSurface);

    try {
      render(<OverlayBridge />);
      await waitFor(() => {
        expect(bridgeMocks.listeners.has('overlay://float-shown')).toBe(true);
        expect(bridgeMocks.listeners.has('overlay://float-hidden')).toBe(true);
      });

      act(() => emit('overlay://float-shown', 'card-1'));
      expect(geometryEvents.at(-1)?.detail).toEqual({ ptyId: 'pty-1' });
      expect(bridgeMocks.overlayState.floatCardId).toBe('card-1');

      act(() => emit('overlay://float-hidden'));
      expect(geometryEvents.at(-1)?.detail).toEqual({ ptyId: 'pty-1' });
      expect(surfaceEvents.at(-1)?.detail).toEqual({ focus: false });
      expect(bridgeMocks.overlayState.floatOpen).toBe(false);
    } finally {
      window.removeEventListener(TERMINAL_GEOMETRY_INVALIDATED_EVENT, onGeometry);
      window.removeEventListener(TERMINAL_SURFACE_SHOWN_EVENT, onSurface);
    }
  });
});
