import type { RequestResult } from '@threadterm/protocol';

export const LARGE_FILE_WINDOW_BYTES = 256 * 1024;
export type TextWindow = RequestResult<'filesystem.readWindow'>;
export type WindowState = { window?: TextWindow; busy: boolean; error?: unknown };
export type WindowRead = (offset: number, changeToken?: TextWindow['changeToken']) => Promise<TextWindow>;

/** Older project reads wrap file_too_large in an invalid_request RPC error. */
export function isLargeFileError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const detail = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  return code === 'file_too_large' || /\bfile_too_large\b/.test(detail);
}

/** Owns one window, with no history/cache, and fences replies after navigation or unmount. */
export function createWindowLoader(read: WindowRead, publish: (state: WindowState) => void) {
  let state: WindowState = { busy: false };
  let generation = 0;
  const update = (next: WindowState) => { state = next; publish(next); };
  return {
    async load(offset: number, reload = false) {
      const ticket = ++generation;
      const token = reload ? undefined : state.window?.changeToken;
      update({ window: reload ? undefined : state.window, busy: true });
      try {
        const window = await read(offset, token);
        if (ticket === generation) update({ window, busy: false });
      } catch (error) {
        // Keep neither obsolete text nor a token after a failed read.
        if (ticket === generation) update({ busy: false, error });
      }
    },
    dispose() { generation++; },
  };
}

export function windowOffset(window: TextWindow, action: 'start' | 'previous' | 'next' | 'end'): number {
  if (action === 'start') return 0;
  if (action === 'previous') return Math.max(0, window.start - LARGE_FILE_WINDOW_BYTES);
  if (action === 'next') return window.end;
  return Math.max(0, window.size - LARGE_FILE_WINDOW_BYTES);
}

export function percentOffset(size: number, percent: number): number {
  return Math.min(Math.max(0, size - LARGE_FILE_WINDOW_BYTES), Math.floor(size * Math.max(0, Math.min(100, percent)) / 100));
}
