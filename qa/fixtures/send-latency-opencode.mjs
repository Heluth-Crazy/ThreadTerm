// Reuse the existing native HTTP/SSE fixture. Delay only its prompt acceptance
// handler; ordinary fixture events are emitted after that handler acknowledges.
import http from 'node:http';
import { appendFileSync } from 'node:fs';
const delayMs = Number(process.env.TT_QA_PROVIDER_DELAY_MS ?? 0);
if (!Number.isFinite(delayMs) || delayMs < 0) throw Error('Invalid fake provider delay');
const log = value => {
  if (process.env.TT_QA_LATENCY_LOG) appendFileSync(process.env.TT_QA_LATENCY_LOG,
    JSON.stringify({ ...value, pid: process.pid, monotonicUs: Number(process.hrtime.bigint() / 1000n) }) + '\n');
};
const create = http.createServer;
http.createServer = function (listener) {
  return create.call(this, (req, res) => {
    if (req.method === 'POST' && new URL(req.url, 'http://fixture').pathname.endsWith('/prompt_async')) {
      log({ stage: 'native.request', provider: 'opencode' });
      const end = res.end;
      res.end = function (...args) { log({ stage: 'native.accepted', provider: 'opencode' }); return end.apply(this, args); };
      const on = req.on;
      req.on = function (event, callback) {
        return on.call(this, event, event === 'end' ? (...args) => {
          if (delayMs) setTimeout(() => callback(...args), delayMs); else callback(...args);
        } : callback);
      };
    }
    listener(req, res);
  });
};
await import('./mock-opencode.mjs');
