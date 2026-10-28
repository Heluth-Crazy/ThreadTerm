import type { ConflictSavedState } from '../workbench/conflictStage';

export const MAX_CONFLICT_STATE_READS = 4;
export const MAX_CONFLICT_STATE_PATHS = 100;

type ReadState = (path: string) => Promise<ConflictSavedState>;

/** A shared queue keeps saved-file inspection bounded even when a refresh is superseded. */
export class ConflictStateScheduler {
  private active = 0;
  private readonly queued: (() => void)[] = [];

  constructor(private readonly concurrency = MAX_CONFLICT_STATE_READS) {}

  scan(paths: readonly string[], read: ReadState, current: () => boolean): Promise<Record<string, ConflictSavedState>> {
    return Promise.all(paths.slice(0, MAX_CONFLICT_STATE_PATHS).map(path => this.schedule(path, read, current))).then(entries => {
      const overflow = paths.slice(MAX_CONFLICT_STATE_PATHS).map(path => [path, {kind: 'unknown'}] as const);
      return Object.fromEntries([...entries.filter((entry): entry is readonly [string, ConflictSavedState] => entry !== undefined), ...overflow]);
    });
  }

  private schedule(path: string, read: ReadState, current: () => boolean): Promise<readonly [string, ConflictSavedState] | undefined> {
    return new Promise(resolve => {
      this.queued.push(() => {
        if (!current()) { resolve(undefined); return; }
        this.active++;
        void read(path).then(
          state => resolve([path, state] as const),
          () => resolve([path, {kind: 'unknown'}] as const),
        ).finally(() => { this.active--; this.drain(); });
      });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queued.length) this.queued.shift()!();
  }
}

export const conflictStateScheduler = new ConflictStateScheduler();

/** A detailed event can narrow refreshes; legacy pathless events are intentionally debounced by the hook. */
export function changedPaths(event: Event): readonly string[] | undefined {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail === 'string') return [detail];
  if (!detail || typeof detail !== 'object') return undefined;
  const value = detail as { path?: unknown; paths?: unknown };
  if (typeof value.path === 'string') return [value.path];
  if (Array.isArray(value.paths) && value.paths.length > 0 && value.paths.every(path => typeof path === 'string')) return value.paths;
  return undefined;
}

export function eventTouchesPaths(event: Event, paths: readonly string[]): boolean {
  const changed = changedPaths(event);
  return changed === undefined || changed.some(path => paths.includes(path));
}

export function shouldDebounceConflictRefresh(event: Event, paths: readonly string[]): boolean {
  return eventTouchesPaths(event, paths) && changedPaths(event) === undefined;
}

/** Coalesces pathless notifications without delaying a newly opened path. */
export class ConflictRefreshDebouncer {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly delayMs: number,
    private readonly scheduleTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = (callback, delay) => globalThis.setTimeout(callback, delay),
    private readonly cancelTimer: (timer: ReturnType<typeof setTimeout>) => void = timer => globalThis.clearTimeout(timer),
  ) {}

  schedule(refresh: () => void): void {
    this.cancel();
    this.timer = this.scheduleTimer(() => { this.timer = undefined; refresh(); }, this.delayMs);
  }

  cancel(): void {
    if (this.timer) this.cancelTimer(this.timer);
    this.timer = undefined;
  }
}
