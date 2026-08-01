/**
 * mountedViewsLru — mount policy for TerminalViews / terminal paint surfaces.
 *
 * Historical (audit P1-1): keep at most MAX_MOUNTED_TERMINAL_VIEWS (6) views.
 * Batch 2 surface pool: keep every actually-visible surface plus a single
 * hidden warm surface; all other cards go cold (xterm unmounted, PTY kept).
 *
 * Feature flag `threadterm.terminalSurfacePool` (and env
 * VITE_THREADTERM_TERMINAL_SURFACE_POOL) can restore the legacy 6-view cap.
 */

/**
 * Legacy cap used when the surface pool feature flag is disabled.
 * Aligned with MAX_PINNED_CARDS (6).
 */
export const MAX_MOUNTED_TERMINAL_VIEWS = 6;

/** Hidden warm surfaces retained in addition to all visible ones. */
export const DEFAULT_WARM_SURFACE_LIMIT = 1;

/** localStorage / managed preference key for emergency rollback. */
export const TERMINAL_SURFACE_POOL_FLAG_KEY = 'threadterm.terminalSurfacePool';

export interface TouchMountedIdResult {
  /** New LRU-ordered array (oldest first, most recently touched last). */
  next: string[];
  /** Ids whose TerminalView should be unmounted, oldest first. */
  evicted: string[];
}

export interface TouchMountedSurfacesOptions {
  /** Cards currently painted in any real window (main focus, float, …). */
  visibleIds: readonly string[];
  /** When false, fall back to the fixed MAX_MOUNTED_TERMINAL_VIEWS policy. */
  poolEnabled: boolean;
  /** Extra hidden warm surfaces. Default 1. */
  warmLimit?: number;
  /** Legacy cap when poolEnabled is false. Default MAX_MOUNTED_TERMINAL_VIEWS. */
  legacyCap?: number;
}

/**
 * Resolve whether the visible+warm surface pool is enabled.
 * Explicit `0/false/off` wins; otherwise defaults to enabled.
 */
export function isTerminalSurfacePoolEnabled(
  envValue?: string | undefined | null,
  storageValue?: string | undefined | null,
): boolean {
  const fromEnv = normalizeFlag(envValue);
  if (fromEnv !== null) return fromEnv;
  const fromStorage = normalizeFlag(storageValue);
  if (fromStorage !== null) return fromStorage;
  return true;
}

function normalizeFlag(value: string | undefined | null): boolean | null {
  if (value == null) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(trimmed)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(trimmed)) return true;
  return null;
}

/**
 * Read the live feature flag from Vite env + browser storage (when present).
 */
export function readTerminalSurfacePoolEnabled(): boolean {
  const envValue =
    typeof import.meta !== 'undefined'
      ? (import.meta.env?.VITE_THREADTERM_TERMINAL_SURFACE_POOL as string | undefined)
      : undefined;
  let storageValue: string | null | undefined;
  try {
    if (typeof localStorage !== 'undefined') {
      storageValue = localStorage.getItem(TERMINAL_SURFACE_POOL_FLAG_KEY);
    }
  } catch {
    storageValue = undefined;
  }
  return isTerminalSurfacePoolEnabled(envValue, storageValue);
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
  return touchMountedIdWithProtections(current, id, cap, protectedId ? [protectedId] : []);
}

/**
 * Surface-pool aware mount reconciliation.
 *
 * - pool on: cap = |unique visible| + warmLimit; every visible id is protected
 * - pool off: legacy fixed cap with the first visible id (focus) protected
 */
export function touchMountedSurfaces(
  current: string[],
  id: string,
  options: TouchMountedSurfacesOptions,
): TouchMountedIdResult {
  const visibleIds = uniqueNonEmpty(options.visibleIds);
  if (!options.poolEnabled) {
    const legacyCap = options.legacyCap ?? MAX_MOUNTED_TERMINAL_VIEWS;
    const protectedId = visibleIds[0] ?? null;
    return touchMountedId(current, id, legacyCap, protectedId);
  }

  const warmLimit = Math.max(0, options.warmLimit ?? DEFAULT_WARM_SURFACE_LIMIT);
  // Ensure every currently visible surface is present before applying LRU.
  let seed = current.filter((existing) => existing !== id);
  for (const visibleId of visibleIds) {
    if (visibleId !== id && !seed.includes(visibleId)) {
      seed.push(visibleId);
    }
  }
  seed.push(id);

  const cap = Math.max(visibleIds.length + warmLimit, warmLimit + (visibleIds.includes(id) ? 0 : 1));
  // Visible surfaces and the just-touched id are never cold-evicted.
  return touchMountedIdWithProtections(seed, id, cap, visibleIds, { alreadyTouched: true });
}

function uniqueNonEmpty(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function touchMountedIdWithProtections(
  current: string[],
  id: string,
  cap: number,
  protectedIds: readonly string[],
  opts?: { alreadyTouched?: boolean },
): TouchMountedIdResult {
  const protectedSet = new Set(protectedIds.filter(Boolean));
  protectedSet.add(id);

  const touched = opts?.alreadyTouched
    ? [...current]
    : [...current.filter((existing) => existing !== id), id];

  // De-dupe while preserving order (last occurrence wins for MRU semantics).
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (let i = touched.length - 1; i >= 0; i -= 1) {
    const candidate = touched[i];
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    ordered.push(candidate);
  }
  ordered.reverse();

  const evicted: string[] = [];
  if (ordered.length <= cap) {
    return { next: ordered, evicted };
  }

  const next: string[] = [];
  let overflow = ordered.length - cap;
  for (const candidate of ordered) {
    if (overflow > 0 && !protectedSet.has(candidate)) {
      evicted.push(candidate);
      overflow -= 1;
    } else {
      next.push(candidate);
    }
  }
  return { next, evicted };
}
