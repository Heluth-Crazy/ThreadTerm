/**
 * mountedViewsLru — LRU policy for persistently mounted TerminalViews
 * (audit P1-1).
 *
 * Why: every mounted TerminalView hosts a Shell instance, which owns one
 * xterm + WebglAddon WebGL context. Browsers/webviews allow only ~8-16 live
 * WebGL contexts; beyond that the oldest context is force-lost and xterm
 * silently falls back to the DOM renderer — unacceptably slow on Windows
 * WebView2 (issues #4/#7). Keeping every ever-focused card mounted therefore
 * breaks down past ~8 cards. Instead we keep at most
 * `MAX_MOUNTED_TERMINAL_VIEWS` views mounted in LRU order; evicted cards
 * unmount their xterm (freeing the WebGL context) while the PTY stays alive
 * in Rust (`preservePtyOnUnmount`), and re-focusing restores the screen and
 * scrollback through the existing `attachSnapshot` path in Shell.jsx.
 */

/**
 * Cap on simultaneously mounted TerminalViews. Aligned with
 * `MAX_PINNED_CARDS` (6): the pinned-card switcher is the largest set of
 * cards a user can rapidly cycle through, and 6 WebGL contexts leave
 * comfortable headroom under the ~8-16 per-page context budget.
 */
export const MAX_MOUNTED_TERMINAL_VIEWS = 6;

export interface TouchMountedIdResult {
  /** New LRU-ordered array (oldest first, most recently touched last). */
  next: string[];
  /** Ids whose TerminalView should be unmounted, oldest first. */
  evicted: string[];
}

/**
 * Mark `id` as most-recently-used and evict over-cap entries from the LRU
 * end. Pure: never mutates `current`.
 *
 * Eviction never removes `protectedId` (the currently focused card must keep
 * its WebGL renderer — visible cards on WebView2 cannot afford the DOM
 * renderer fallback) nor the just-touched `id`. If every entry is protected
 * the result may temporarily exceed `cap`.
 */
export function touchMountedId(
  current: string[],
  id: string,
  cap: number,
  protectedId: string | null,
): TouchMountedIdResult {
  const touched = current.filter((existing) => existing !== id);
  touched.push(id);

  const evicted: string[] = [];
  if (touched.length <= cap) {
    return { next: touched, evicted };
  }

  // Walk from the LRU end (head) and evict the oldest unprotected entries
  // until we are back under the cap or run out of evictable candidates.
  const next: string[] = [];
  let overflow = touched.length - cap;
  for (const candidate of touched) {
    if (overflow > 0 && candidate !== id && candidate !== protectedId) {
      evicted.push(candidate);
      overflow -= 1;
    } else {
      next.push(candidate);
    }
  }
  return { next, evicted };
}
