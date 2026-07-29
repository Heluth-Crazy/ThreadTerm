import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type { MockTerminal } from './Shell.testHarness';

export function fitAddonFor(term: MockTerminal) {
  return term.loadAddon.mock.calls[0]?.[0] as
    | { fit: ReturnType<typeof vi.fn> }
    | undefined;
}

export function installManualSurfaceScheduler() {
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

  const clearScheduledTimeout = vi.fn(
    (handle: Parameters<typeof clearTimeout>[0]) => {
      if (typeof handle === 'number') timeouts.delete(handle);
    },
  );
  const setTimeoutSpy = vi
    .spyOn(window, 'setTimeout')
    .mockImplementation((handler: (_: void) => void, timeout?: number) => {
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
      const entry = Array.from(timeouts.entries()).find(
        ([, timer]) => timer.delay === delay,
      );
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

export function installGeometry(width: number, height: number) {
  const geometry = { width, height };
  const spy = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          width: geometry.width,
          height: geometry.height,
          top: 0,
          left: 0,
          right: geometry.width,
          bottom: geometry.height,
          toJSON: () => ({}),
        }) as DOMRect,
    );
  return { geometry, spy };
}
