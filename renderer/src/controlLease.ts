type LeaseApi = {
  claim: (id: string) => Promise<number>;
  renew: (id: string, epoch: number) => Promise<unknown>;
  release: (id: string, epoch: number) => Promise<unknown>;
};
export function createLeasePool(api: LeaseApi, renewEveryMs = 10_000) {
  type Entry = { refs: number; ready: Promise<number>; closing?: Promise<void>; timer?: ReturnType<typeof setInterval>; listeners: Set<() => void>; dead?: boolean };
  const entries = new Map<string, Entry>();
  return async function acquire(id: string, onLost: () => void): Promise<{epoch:number;release():void}> {
    let entry = entries.get(id);
    if (entry?.closing) { await entry.closing; return acquire(id, onLost); }
    if (entry?.dead) { entries.delete(id); entry = undefined; }
    if (!entry) {
      entry = {refs: 0, ready: api.claim(id), listeners: new Set()};
      entries.set(id, entry);
      const created = entry;
      void created.ready.then(epoch => {
        if (created.dead) return;
        created.timer = setInterval(() => void api.renew(id, epoch).catch(() => {
          if (created.dead) return;
          created.dead = true;
          clearInterval(created.timer);
          if (entries.get(id) === created) entries.delete(id);
          const listeners = [...created.listeners];
          created.listeners.clear();
          for (const listener of listeners) listener();
        }), renewEveryMs);
      }).catch(() => { if (entries.get(id) === created) entries.delete(id); });
    }
    const current = entry;
    current.refs++; current.listeners.add(onLost);
    let epoch: number;
    try { epoch = await current.ready; }
    catch (error) { current.refs--; current.listeners.delete(onLost); throw error; }
    let released = false;
    return {epoch, release() {
      if (released) return;
      released = true; current.listeners.delete(onLost); current.refs--;
      if (current.dead || current.refs) return;
      clearInterval(current.timer);
      current.closing = api.release(id, epoch).catch(() => undefined).then(() => {
        if (entries.get(id) === current) entries.delete(id);
      });
    }};
  };
}
async function runtimeRequest<M extends 'session.claim' | 'session.renew' | 'session.release'>(
  method: M,
  params: M extends 'session.claim' ? {sessionId: string; clientId: string} : {sessionId: string; leaseEpoch: number},
) {
  const { request } = await import('./bridge');
  return request(method, params as never);
}

export const acquireControl = createLeasePool({
  claim: async sessionId => (await runtimeRequest('session.claim', {sessionId, clientId: 'threadterm-renderer'})).leaseEpoch,
  renew: (sessionId, leaseEpoch) => runtimeRequest('session.renew', {sessionId, leaseEpoch}),
  release: (sessionId, leaseEpoch) => runtimeRequest('session.release', {sessionId, leaseEpoch}),
});
