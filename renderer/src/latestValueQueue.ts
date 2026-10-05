/** Pure patch queue: only one patch may be taken at a time; waiting edits coalesce by key. */
export function createLatestValueQueue<T extends object>() {
  let pending: Partial<T> = {}, active: Partial<T> | undefined;
  return {
    stage(patch: Partial<T>) { pending = { ...pending, ...patch }; },
    take(): Partial<T> | undefined {
      if (active || !Object.keys(pending).length) return undefined;
      active = pending; pending = {}; return active;
    },
    finish() { active = undefined; },
    has(key: keyof T) { return key in pending || !!active && key in active; },
  };
}
