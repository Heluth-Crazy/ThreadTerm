/** A deferred, coalescing refresh: one run at a time with at most one waiting behind it.
 *
 * Panels ask for freshness when something can have changed; without a timer. Bursts collapse, so a
 * commit that also fires a file-changed event still costs one refresh instead of two RPCs, and every
 * request resolves once the run that covers it finished. */
export type RefreshQueue = { request:() => Promise<void>; stop:() => void };

export function createRefreshQueue(run:() => Promise<unknown>):RefreshQueue {
 let running = false, queued = false, stopped = false, waiters:(()=>void)[] = [];
 const settle = () => { const done = waiters; waiters = []; for(const finish of done) finish(); };
 const drain = async () => {
  running = true;
  try { await run(); } catch { /* the panel shows its own error, the queue stays usable */ }
  running = false;
  if(queued && !stopped) { queued = false; return drain(); }
  settle();
 };
 return {
  request: () => new Promise<void>(done => {
   if(stopped) { done(); return; }
   waiters.push(done);
   if(running) queued = true; else void drain();
  }),
  stop: () => { stopped = true; queued = false; settle(); },
 };
}
