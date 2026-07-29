// NDJSON protocol between the Rust backend and this sidecar.
// Requests (Rust -> sidecar) carry a numeric `id` and an `op`; the sidecar
// answers with `{id, ok}` or `{id, error}`. Events (sidecar -> Rust) carry an
// `ev` field and no id. One JSON document per line in both directions.

export const OPS = new Set([
  'session.start',
  'session.send',
  'session.interrupt',
  'session.set_model',
  'session.set_permission_mode',
  'session.decision',
  'session.stop',
  'session.history',
  'host.ping',
]);

export function parseRequestLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    return { error: `invalid JSON: ${err.message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'request must be a JSON object' };
  }
  if (!Number.isInteger(value.id)) {
    return { error: 'request is missing an integer id' };
  }
  if (typeof value.op !== 'string' || !OPS.has(value.op)) {
    return { id: value.id, error: `unknown op: ${String(value.op)}` };
  }
  return { request: value };
}

export function responseOk(id, payload = {}) {
  return { id, ok: payload };
}

export function responseError(id, message) {
  return { id, error: { message: String(message) } };
}

export function eventSessionEvent(cardId, message) {
  return { ev: 'session.event', cardId, message };
}

export function eventSessionRequest(cardId, requestId, kind, payload) {
  return { ev: 'session.request', cardId, requestId, kind, ...payload };
}

export function eventSessionRequestCancelled(cardId, requestId) {
  return { ev: 'session.request_cancelled', cardId, requestId };
}

export function eventSessionStatus(cardId, phase, extra = {}) {
  return { ev: 'session.status', cardId, phase, ...extra };
}

export function eventHostFatal(error) {
  return { ev: 'host.fatal', error: String(error) };
}
