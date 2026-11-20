/**
 * Multiple visible surfaces can describe the same worktree.  Their local
 * refresh queues still decide when a new status is needed, but a request that
 * is already crossing the desktop boundary is shared by every surface.
 */
const pending = new Map<string, Promise<unknown>>();

export function sharedGitStatusRequest<T>(scopeKey: string, load: () => Promise<T>): Promise<T> {
  const current = pending.get(scopeKey) as Promise<T> | undefined;
  if (current) return current;
  const request = Promise.resolve().then(load);
  pending.set(scopeKey, request);
  void request.then(
    () => { if (pending.get(scopeKey) === request) pending.delete(scopeKey); },
    () => { if (pending.get(scopeKey) === request) pending.delete(scopeKey); },
  );
  return request;
}
