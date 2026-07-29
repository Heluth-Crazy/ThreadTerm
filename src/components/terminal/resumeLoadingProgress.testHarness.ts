import { afterEach, beforeEach, vi } from 'vitest';

let nextFrameHandle = 1;
export const frames = new Map<number, FrameRequestCallback>();

export const runNextFrame = () => {
  const entry = frames.entries().next().value as
    | [number, FrameRequestCallback]
    | undefined;
  if (!entry) throw new Error('expected a queued animation frame');
  const [handle, callback] = entry;
  frames.delete(handle);
  callback(performance.now());
};

beforeEach(() => {
  vi.useFakeTimers();
  nextFrameHandle = 1;
  frames.clear();
  vi.stubGlobal(
    'requestAnimationFrame',
    (callback: FrameRequestCallback) => {
      const handle = nextFrameHandle;
      nextFrameHandle += 1;
      frames.set(handle, callback);
      return handle;
    },
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    (handle: number) => {
      frames.delete(handle);
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
