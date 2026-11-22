/** Retain a parsed screen for a short tab-switch round trip. The owner releases
 * its output subscription and input lease before parking it here. */
export function createTerminalScreenCache<T extends { dispose(): void }>(subscribeReset: (reset: () => void) => () => void, limit = 2, lifetimeMs = 60_000) {
  const entries = new Map<string, { screen: T; timer: ReturnType<typeof setTimeout> }>();
  let unsubscribe: (() => void) | undefined;
  function take(key: string) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    entries.delete(key);
    if (!entries.size) { unsubscribe?.(); unsubscribe = undefined; }
    return entry.screen;
  }
  function remove(key: string) { take(key)?.dispose(); }
  return {
    take,
    park(key: string, screen: T) {
      remove(key);
      if (entries.size >= limit) remove(entries.keys().next().value!);
      entries.set(key, { screen, timer: setTimeout(() => remove(key), lifetimeMs) });
      unsubscribe ??= subscribeReset(() => { for (const key of entries.keys()) remove(key); });
    },
  };
}

export function canResumeTerminalScreen(cursor: number, originalStart: number, retainedStart: number, end: number) {
  return originalStart === retainedStart && cursor >= retainedStart && cursor <= end;
}
