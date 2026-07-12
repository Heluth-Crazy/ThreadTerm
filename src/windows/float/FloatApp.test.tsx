import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const floatMocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload?: unknown }) => void>>(),
  listen: vi.fn(),
  invoke: vi.fn(async () => undefined),
  isVisible: vi.fn(async () => false),
  setAlwaysOnTop: vi.fn(async () => undefined),
  terminalRehydrate: vi.fn(),
  overlayRehydrate: vi.fn(),
  terminalSetState: vi.fn(),
  overlaySetState: vi.fn(),
  terminalState: { cards: [] as unknown[] },
  overlayState: { floatCardId: null as string | null },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: floatMocks.listen,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isVisible: floatMocks.isVisible,
    setAlwaysOnTop: floatMocks.setAlwaysOnTop,
  }),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  invoke: floatMocks.invoke,
}));

vi.mock('../../stores/terminalStore', () => {
  const useTerminalStore = Object.assign(
    (selector: (state: typeof floatMocks.terminalState) => unknown) =>
      selector(floatMocks.terminalState),
    {
      persist: { rehydrate: floatMocks.terminalRehydrate },
      setState: floatMocks.terminalSetState,
    },
  );
  return { useTerminalStore };
});

vi.mock('../../stores/overlayStore', () => {
  const useOverlayStore = Object.assign(
    (selector: (state: typeof floatMocks.overlayState) => unknown) =>
      selector(floatMocks.overlayState),
    {
      persist: { rehydrate: floatMocks.overlayRehydrate },
      setState: floatMocks.overlaySetState,
    },
  );
  return { useOverlayStore };
});

vi.mock('./FloatHeader', () => ({
  FloatHeader: () => <div data-testid="float-header" />,
}));

vi.mock('./FloatSession', () => ({
  FloatSession: ({ active }: { active?: boolean }) => (
    <div data-testid="float-session" data-active={String(active)} />
  ),
}));

vi.mock('./useFloatBoundsSync', () => ({
  useFloatBoundsSync: vi.fn(),
}));

import { FloatApp } from './FloatApp';
import { TERMINAL_GEOMETRY_INVALIDATED_EVENT } from '../../components/terminal/terminalSurfaceEvents';

function emit(event: string, payload?: unknown) {
  for (const handler of floatMocks.listeners.get(event) ?? []) {
    handler({ payload });
  }
}

beforeEach(() => {
  floatMocks.listeners.clear();
  vi.clearAllMocks();
  floatMocks.overlayState.floatCardId = null;
  floatMocks.listen.mockImplementation(
    async (event: string, handler: (event: { payload?: unknown }) => void) => {
      const handlers = floatMocks.listeners.get(event) ?? new Set();
      handlers.add(handler);
      floatMocks.listeners.set(event, handlers);
      return () => handlers.delete(handler);
    },
  );
  floatMocks.isVisible.mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
});

describe('FloatApp visibility lifecycle', () => {
  it('recovers visible state when the initial shown event was missed', async () => {
    floatMocks.isVisible.mockResolvedValueOnce(true);
    render(<FloatApp />);

    await waitFor(() => {
      expect(screen.getByTestId('float-session')).toHaveAttribute('data-active', 'true');
    });
  });

  it('activates only while the native float surface is shown', async () => {
    const geometryInvalidated = vi.fn();
    window.addEventListener(TERMINAL_GEOMETRY_INVALIDATED_EVENT, geometryInvalidated);
    let resolveInitialVisibility: ((visible: boolean) => void) | undefined;
    const initialVisibility = new Promise<boolean>((resolve) => {
      resolveInitialVisibility = resolve;
    });
    floatMocks.isVisible.mockReturnValueOnce(initialVisibility);
    render(<FloatApp />);

    await waitFor(() => {
      expect(floatMocks.listeners.has('overlay://float-shown')).toBe(true);
      expect(floatMocks.listeners.has('overlay://float-hidden')).toBe(true);
      expect(floatMocks.isVisible).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('float-session')).toHaveAttribute('data-active', 'false');

    act(() => emit('overlay://float-shown', 'card-1'));
    expect(screen.getByTestId('float-session')).toHaveAttribute('data-active', 'true');
    expect(floatMocks.terminalRehydrate).toHaveBeenCalledTimes(1);
    expect(floatMocks.overlayRehydrate).toHaveBeenCalledTimes(1);
    expect(geometryInvalidated).toHaveBeenCalledTimes(1);

    // A native visibility query started before listener setup must not
    // overwrite a newer shown event when its stale result arrives later.
    await act(async () => {
      resolveInitialVisibility?.(false);
      await initialVisibility;
    });
    expect(screen.getByTestId('float-session')).toHaveAttribute('data-active', 'true');

    // This event is also emitted by Rust's global show-main path, not only by
    // the FloatApp header action.
    act(() => emit('overlay://float-hidden'));
    expect(screen.getByTestId('float-session')).toHaveAttribute('data-active', 'false');
    expect(geometryInvalidated).toHaveBeenCalledTimes(2);
    window.removeEventListener(TERMINAL_GEOMETRY_INVALIDATED_EVENT, geometryInvalidated);
  });
});
