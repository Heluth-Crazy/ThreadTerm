/**
 * Draft state for the Retry maximum field (F21). The loaded policy and the text
 * the user typed stay separate so an unrelated event reload never discards a
 * dirty field; a reload that finds a newer stored value only raises a conflict.
 */
export type RetryDraft = { loaded: number; value: number; dirty: boolean; conflict: boolean };

export const clampRetryMaximum = (value: number) => Math.max(1, Math.min(10, Number.isFinite(value) ? Math.round(value) : 1));
export const initialRetryDraft = (loaded: number): RetryDraft => ({ loaded, value: loaded, dirty: false, conflict: false });

export function editRetryDraft(draft: RetryDraft, value: number): RetryDraft {
  const next = clampRetryMaximum(value);
  return { loaded: draft.loaded, value: next, dirty: next !== draft.loaded, conflict: false };
}

/** Applies a policy reload: a clean field follows the stored value, a dirty one keeps the draft. */
export function mergeStoredRetry(draft: RetryDraft, stored: number): RetryDraft {
  if (!draft.dirty) return initialRetryDraft(stored);
  return draft.loaded === stored ? draft : { ...draft, loaded: stored, conflict: true };
}

/** The user chose the stored value over their draft. */
export const adoptStoredRetry = (draft: RetryDraft): RetryDraft => initialRetryDraft(draft.loaded);

/** The save returned the stored value; the draft is clean again. */
export const savedRetryDraft = (stored: number): RetryDraft => initialRetryDraft(stored);

/**
 * Retry state only changes through retry scheduler events, a session launch and
 * that session's own status. Everything else (another session, chat activity,
 * a title change) must not reload this panel.
 */
export function retryEventRelevant(event: { event: string; data?: unknown }, sessionId: string): boolean {
  const data = event.data && typeof event.data === "object" ? event.data as { sessionId?: unknown; kind?: unknown } : undefined;
  if (data?.sessionId !== undefined && data.sessionId !== sessionId) return false;
  if (event.event === "session.status") return data?.sessionId === sessionId;
  if (event.event !== "state.changed") return false;
  const kind = typeof data?.kind === "string" ? data.kind : "";
  return kind.startsWith("retry.") || kind === "session.launch";
}
