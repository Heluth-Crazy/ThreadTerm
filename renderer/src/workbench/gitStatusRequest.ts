/**
 * Multiple visible surfaces can describe the same worktree.  Their local
 * refresh queues still decide when a new status is needed; callers in the same
 * turn share one request.  A request already crossing the desktop boundary may
 * have read the worktree before the change that made a later caller refresh,
 * so later callers share one follow-up request that starts after it.
 */
interface Scope {
  /** Started, possibly before the latest caller's change. */
  running?: Promise<unknown>;
  /** Not sent yet: every caller may still join it. */
  waiting?: Promise<unknown>;
}

const scopes = new Map<string, Scope>();

export function sharedGitStatusRequest<T>(scopeKey: string, load: () => Promise<T>): Promise<T> {
  let scope = scopes.get(scopeKey);
  if (!scope) scopes.set(scopeKey, scope = {});
  if (scope.waiting) return scope.waiting as Promise<T>;
  const owner = scope;
  const before = owner.running?.then(() => undefined, () => undefined) ?? Promise.resolve();
  const request = before.then(() => {
    owner.waiting = undefined;
    owner.running = request;
    return load();
  });
  owner.waiting = request;
  void request.then(finish, finish);
  function finish() {
    if (owner.running === request) owner.running = undefined;
    if (!owner.running && !owner.waiting && scopes.get(scopeKey) === owner) scopes.delete(scopeKey);
  }
  return request;
}
