// Reference implementations and fixtures for the F11 chat presentation work.
// `chatPresentationIndex` replaced these whole-history scans; both the
// equivalence test and the benchmark compare against them, so they must stay
// verbatim copies of the pre-F11 code.

export function legacyTurnIsSettled(items) {
  const status = [...items].reverse().find(item => item.turnStatus)?.turnStatus;
  return status ? status === 'completed' || status === 'failed' || status === 'interrupted' : items.some(item => item.elapsedMs != null);
}

function legacyLastIndex(items, match) {
  for (let index = items.length - 1; index >= 0; index -= 1) if (match(items[index])) return index;
  return -1;
}

export function legacyItemShowsStreaming(item, items) {
  if (item.turnOrigin === 'history') return false;
  if (legacyTurnIsSettled(item.turnId ? items.filter(entry => entry.turnId === item.turnId && entry.turnOrigin !== 'history') : [item])) return false;
  const lastUser = legacyLastIndex(items, entry => entry.turnOrigin !== 'history' && entry.role === 'user');
  const lastAssistant = legacyLastIndex(items, entry => entry.turnOrigin !== 'history' && entry.role === 'assistant');
  const index = items.findIndex(entry => entry.turnOrigin !== 'history' && entry.id === item.id);
  if (index < 0 || index !== lastAssistant) return false;
  if (lastUser >= 0 && lastAssistant < lastUser) return false;
  return item.parts.some(part => part.status === 'streaming' || part.status === 'running');
}

export function legacyActiveTurnId(items, sessionStatus) {
  if (sessionStatus !== undefined && sessionStatus !== 'running' && sessionStatus !== 'waiting') return undefined;
  const latest = [...items].reverse().find(item => item.turnId && item.turnOrigin !== 'history');
  if (!latest?.turnId) return undefined;
  const turnId = latest.turnId;
  if (legacyTurnIsSettled(items.filter(item => item.turnId === turnId && item.turnOrigin !== 'history'))) return undefined;
  if (sessionStatus !== undefined) return turnId;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.turnId !== turnId || item.turnOrigin === 'history') continue;
    if (item.parts.some(part => part.status === 'streaming' || part.status === 'running' || (part.type === 'approval' && part.status === 'pending'))) return item.turnId;
  }
  return undefined;
}

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Adversarial records: history rows, repeated and missing turn ids, settlement collisions. */
export function randomTranscript(random, size) {
  const pick = values => values[Math.floor(random() * values.length)];
  return Array.from({ length: size }, (_, index) => {
    const item = {
      id: `i${index}`,
      role: pick(['user', 'assistant', 'assistant', 'system']),
      createdAt: String(index),
      parts: Array.from({ length: Math.floor(random() * 4) }, () => {
        const part = { type: pick(['text', 'thinking', 'tool', 'approval', 'usage', 'status']) };
        const status = pick([undefined, 'complete', 'streaming', 'running', 'failed', 'declined']);
        if (status) part.status = status;
        if (part.type === 'text' || part.type === 'thinking') part.text = `body ${index}`;
        if (part.type === 'approval' && random() < 0.5) part.status = 'pending';
        return part;
      }),
    };
    const turnId = pick([undefined, 'turn-a', 'turn-b', 'turn-c', 'shared-turn']);
    if (turnId) item.turnId = turnId;
    if (random() < 0.2) item.turnOrigin = 'history';
    const turnStatus = pick([undefined, undefined, 'completed', 'failed', 'interrupted', 'inProgress', 'unknown']);
    if (turnStatus) item.turnStatus = turnStatus;
    if (random() < 0.2) item.elapsedMs = 1000;
    return item;
  });
}

/**
 * A long but ordinary session: each settled turn is a user message, two
 * activity records and a final answer, then one live streaming turn whose
 * caret is what a streaming update re-renders.
 */
export function sessionTranscript(size) {
  const items = [];
  const completed = Math.max(0, Math.floor((size - 2) / 5));
  for (let turn = 0; turn < completed; turn += 1) {
    const turnId = `turn-${turn}`, first = items.length;
    items.push({ id: `${turnId}-user`, role: 'user', turnId, createdAt: String(first), parts: [{ type: 'text', text: `Prompt ${turn}`, status: 'complete' }] });
    items.push({ id: `${turnId}-thinking`, role: 'assistant', turnId, createdAt: String(first + 1), parts: [{ type: 'thinking', text: 'Working through the request', status: 'complete' }] });
    items.push({ id: `${turnId}-tool`, role: 'assistant', turnId, createdAt: String(first + 2), parts: [{ type: 'tool', toolName: 'Read', toolId: `tool-${turn}`, status: 'complete', text: 'AGENTS.md' }] });
    items.push({ id: `${turnId}-answer`, role: 'assistant', turnId, createdAt: String(first + 3), elapsedMs: 6000, parts: [{ type: 'text', text: `Answer ${turn}`, status: 'complete' }] });
    items.push({ id: `${turnId}-done`, role: 'assistant', turnId, createdAt: String(first + 4), turnStatus: 'completed', elapsedMs: 6000, parts: [] });
  }
  items.push({ id: 'live-user', role: 'user', turnId: 'turn-live', createdAt: 'live', parts: [{ type: 'text', text: 'Long session, now streaming', status: 'complete' }] });
  items.push({ id: 'live-answer', role: 'assistant', turnId: 'turn-live', createdAt: 'live', parts: [{ type: 'text', text: 'Streaming answer', status: 'streaming' }] });
  return items;
}
