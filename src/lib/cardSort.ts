/**
 * Shared card ordering — "activity first".
 *
 * Both the desktop CardGrid and the mobile session list order cards by the same
 * three-tier rule so a user moving between screens sees a consistent layout:
 *
 *   1. live cards first        (a PTY is actively running / waiting for input)
 *   2. then unread cards       (new output the user has not looked at)
 *   3. then most recent first  (lastActivity, falling back to createdAt)
 *
 * The comparator takes a structural shape so desktop `TerminalCard`
 * (status: 'idle'|'running'|'waiting'|...) and mobile `CardMeta`
 * (status: ...|'waiting_for_input', optional/nullable fields) can both feed it
 * without a type cast. Desktop "live" is derived from `status`; mobile callers
 * may carry an explicit `ptyLive` boolean which takes precedence.
 *
 * IMPORTANT: this comparator never mutates the input array. Callers should sort
 * a copy (`[...cards].sort(compareCardsByActivity)`) — the underlying store
 * array (e.g. `terminalStore.cards`) must keep creation order for keyboard
 * navigation (nextCard / prevCard / jumpToIndex).
 */

/** Status values that mean a PTY is live, across desktop + mobile vocabularies. */
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'waiting', // desktop TerminalStatus
  'waiting_for_input', // mobile bridge TerminalStatus
]);

/** True when a desktop status string represents a live PTY. */
export function isDesktopCardLive(status: string | null | undefined): boolean {
  return status != null && LIVE_STATUSES.has(status);
}

/** Minimal shape both desktop and mobile cards satisfy for ordering. */
export interface CardActivitySortFields {
  status?: string | null;
  unread?: boolean | null;
  lastActivity?: number | null;
  createdAt?: number | null;
  /** Mobile-only explicit live flag; overrides `status` when present. */
  ptyLive?: boolean | null;
}

/** Minimal shape for cards that can be projected through a persisted id order. */
export interface CardManualOrderFields {
  id: string;
}

function isLive(card: CardActivitySortFields): boolean {
  if (typeof card.ptyLive === 'boolean') return card.ptyLive;
  return isDesktopCardLive(card.status);
}

/**
 * Comparator implementing the "activity first" ordering. Stable for equal
 * cards (returns 0), so `Array.prototype.sort` preserves their relative order.
 */
export function compareCardsByActivity(
  a: CardActivitySortFields,
  b: CardActivitySortFields,
): number {
  const liveDelta = Number(isLive(b)) - Number(isLive(a));
  if (liveDelta !== 0) return liveDelta;

  const unreadDelta = Number(Boolean(b.unread)) - Number(Boolean(a.unread));
  if (unreadDelta !== 0) return unreadDelta;

  const recencyA = a.lastActivity ?? a.createdAt ?? 0;
  const recencyB = b.lastActivity ?? b.createdAt ?? 0;
  return recencyB - recencyA;
}

/**
 * Project cards through a persisted id order without mutating the source list.
 *
 * Invalid ids are ignored, duplicate ids are collapsed, and any current cards
 * missing from the persisted order are appended in their input order. This
 * keeps older persisted snapshots forward-compatible when cards are created by
 * code paths that did not yet know about manual project ordering.
 */
export function orderCardsByIdList<T extends CardManualOrderFields>(
  cards: readonly T[],
  orderedIds: readonly string[] | null | undefined,
): T[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const seen = new Set<string>();
  const ordered: T[] = [];

  for (const id of orderedIds ?? []) {
    const card = byId.get(id);
    if (!card || seen.has(id)) continue;
    ordered.push(card);
    seen.add(id);
  }

  for (const card of cards) {
    if (seen.has(card.id)) continue;
    ordered.push(card);
    seen.add(card.id);
  }

  return ordered;
}
