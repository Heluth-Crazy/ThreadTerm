// Session list shaping for the Usage page: request parameters, paging and row labels. Pure so the paging/sorting
// rules and the label fallbacks are unit-testable without a runtime.
import type { UsageLedgerSession } from '@threadterm/protocol';

export type UsageSessionSort = 'tokens' | 'cost' | 'recent' | 'activeTime';

export const USAGE_SESSION_SORTS: UsageSessionSort[] = ['tokens', 'cost', 'recent', 'activeTime'];
export const SESSION_PAGE_SIZE = 25;

export type SessionQuery = {
  sort: UsageSessionSort;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
  search?: string;
};

/** The runtime validates 1..200 / offset >= 0 / search <= 256, so the page clamps instead of failing the RPC. */
export function sessionQuery(options: { sort: UsageSessionSort; offset: number; limit?: number; search?: string }): SessionQuery {
  const limit = Math.min(200, Math.max(1, Math.round(options.limit ?? SESSION_PAGE_SIZE)));
  const offset = Math.max(0, Math.round(Number.isFinite(options.offset) ? options.offset : 0));
  const search = (options.search ?? '').trim().slice(0, 256);
  return { sort: options.sort, order: 'desc', limit, offset, ...(search ? { search } : {}) };
}

export function pageCount(total: number, limit: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / Math.max(1, limit)));
}

/** Keeps the offset on the last page when the previous page was the end of a shrinking list. */
export function clampOffset(offset: number, total: number, limit: number): number {
  const maxOffset = (pageCount(total, limit) - 1) * Math.max(1, limit);
  return Math.max(0, Math.min(Math.max(0, Math.round(offset)), maxOffset));
}

/** The last path segment of a recorded folder. Drive letters and user names are never shown on their own. */
export function folderName(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1);
  if (!last || /^[a-z]:$/i.test(last)) return null;
  return last;
}

/** A native id is long and unreadable but is the only identity some sources give; keep a stable short form. */
export function shortNativeId(id: string): string {
  const trimmed = id.trim();
  return trimmed.length <= 12 ? trimmed : `${trimmed.slice(0, 12)}…`;
}

/**
 * The row heading: the ThreadTerm session title when the row is one, the folder it ran in otherwise (outside history
 * has no title anywhere), and finally the native coordinate. `null` means the page has to name the row itself.
 */
export function sessionHeading(session: Pick<UsageLedgerSession, 'threadtermSessionId' | 'cwd' | 'nativeSessionId'>, threadtermTitle?: string): string | null {
  if (session.threadtermSessionId && threadtermTitle?.trim()) return threadtermTitle.trim();
  const folder = folderName(session.cwd);
  if (folder) return folder;
  if (session.threadtermSessionId) return null;
  return session.nativeSessionId.trim() ? shortNativeId(session.nativeSessionId) : null;
}

/** One model, plus how many others the session also used. An empty list means the provider reported no model. */
export function modelLabel(models: readonly string[]): { model: string; extra: number } | null {
  const known = models.filter(model => model.trim().length > 0);
  if (!known.length) return null;
  return { model: known[0]!, extra: known.length - 1 };
}

export type SessionFactLine = {
  requests: number;
  tokens: number;
  pricedTokens: number;
  unpricedTokens: number;
  apiEquivalentUsd: number | null;
  activeTimeMs: number;
  lastOccurredAt: string;
};

export const sessionFacts = (session: UsageLedgerSession): SessionFactLine => ({
  requests: session.requests,
  tokens: session.tokens.total,
  pricedTokens: session.cost.pricedTokens,
  unpricedTokens: session.cost.unpricedTokens,
  apiEquivalentUsd: session.cost.apiEquivalentUsd,
  activeTimeMs: session.activeTimeMs,
  lastOccurredAt: session.lastOccurredAt,
});
