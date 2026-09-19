export const OPS = new Set([
  'host.ping', 'history.list', 'history.read', 'session.start', 'session.send',
  'session.interrupt', 'session.decision', 'session.stop',
]);

export function parseLine(line) {
  let value;
  try { value = JSON.parse(line); } catch (error) { return { error: `invalid JSON: ${error.message}` }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'request must be an object' };
  if (!Number.isInteger(value.id)) return { error: 'request id must be an integer' };
  if (!OPS.has(value.op)) return { id: value.id, error: `unknown op: ${String(value.op)}` };
  return { request: value };
}

export const ok = (id, payload = {}) => ({ id, ok: payload });
export const fail = (id, error) => ({ id, error: { message: String(error?.message ?? error) } });
export const event = (cardId, kind, payload = {}) => ({ ev: kind, cardId, ...payload });
