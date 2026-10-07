type LeaseApi = {
  claim: (id: string) => Promise<number>;
  renew: (id: string, epoch: number) => Promise<unknown>;
  release: (id: string, epoch: number) => Promise<unknown>;
};
export function createLeasePool(api: LeaseApi, renewEveryMs = 10_000) {
  type Entry = { refs: number; ready: Promise<number>; renewing?: Promise<void>; closing?: Promise<void>; timer?: ReturnType<typeof setInterval>; listeners: Set<() => void>; dead?: boolean };
  const entries = new Map<string, Entry>();
  return async function acquire(id: string, onLost: () => void): Promise<{epoch:number;check():Promise<void>;release():void}> {
    let entry = entries.get(id);
    if (entry?.closing) { await entry.closing; return acquire(id, onLost); }
    if (entry?.dead) { entries.delete(id); entry = undefined; }
    if (!entry) {
      entry = {refs: 0, ready: api.claim(id), listeners: new Set()};
      entries.set(id, entry);
      const created = entry;
      void created.ready.then(epoch => {
        if (created.dead) return;
        created.timer = setInterval(() => void check(created, id, epoch).catch(() => undefined), renewEveryMs);
      }).catch(() => { if (entries.get(id) === created) entries.delete(id); });
    }
    function check(created: Entry, id: string, epoch: number): Promise<void> {
      if (created.dead || !created.refs) return Promise.reject(new Error('stale_lease'));
      if (created.renewing) return created.renewing;
      const renewing = Promise.resolve().then(() => api.renew(id, epoch)).then(() => undefined).catch(error => {
          if (created.dead) return;
          created.dead = true;
          clearInterval(created.timer);
          if (entries.get(id) === created) entries.delete(id);
          const listeners = [...created.listeners];
          created.listeners.clear();
          for (const listener of listeners) listener();
          throw error;
      }).finally(() => { if (created.renewing === renewing) created.renewing = undefined; });
      created.renewing = renewing;
      return renewing;
    }
    const current = entry;
    current.refs++; current.listeners.add(onLost);
    let epoch: number;
    try { epoch = await current.ready; }
    catch (error) { current.refs--; current.listeners.delete(onLost); throw error; }
    let released = false;
    return {epoch, check: () => released ? Promise.reject(new Error('stale_lease')) : check(current, id, epoch), release() {
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
