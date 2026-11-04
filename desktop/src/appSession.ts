/** Electron Session objects are stable per partition. Failed setup is never advertised as ready. */
export function createAppSessionPreparer<S extends object>(setup: (session: S) => boolean): (session: S) => boolean {
  const prepared = new WeakMap<S, boolean>();
  return session => {
    const previous = prepared.get(session);
    if (previous !== undefined) return previous;
    const ready = setup(session);
    prepared.set(session, ready);
    return ready;
  };
}
