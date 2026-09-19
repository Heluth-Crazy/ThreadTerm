import type { Session } from "@threadterm/protocol";
export type SessionScope = "all" | "active" | "recent" | "followed" | "bookmarked" | "archived";
export type SessionSort = "updated" | "title" | "provider";

/** Imported read-only history is idle by design, not a live process. */
export function isProcessActive(session: Pick<Session, "status" | "readOnly">): boolean {
  return !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status);
}

/** Ordinary navigation deliberately excludes archived sessions. Archive is an
 * explicit scope so ending a session cannot make it disappear irretrievably. */
export function visibleSessions(
  sessions: Session[],
  query: string,
  scope: SessionScope,
  sort: SessionSort,
  recentIds: readonly string[] = [],
) {
  const q = query.trim().toLocaleLowerCase();
  const recent = new Set(recentIds);
  return sessions
    .filter((session) => {
      const archived = Boolean(session.archived);
      const inScope =
        scope === "archived"
          ? archived
          : !archived &&
            (scope === "all" ||
              (scope === "active" && isProcessActive(session)) ||
              (scope === "recent" && recent.has(session.id)) ||
              (scope === "followed" && session.followed) ||
              (scope === "bookmarked" && session.bookmarked));
      return (
        inScope &&
        (!q ||
          `${session.title} ${session.provider} ${session.worktreePath ?? ""} ${session.intent ?? ""}`
            .toLocaleLowerCase()
            .includes(q))
      );
    })
    .sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "provider"
          ? a.provider.localeCompare(b.provider) || b.updatedAt.localeCompare(a.updatedAt)
          : b.updatedAt.localeCompare(a.updatedAt),
    );
}

export function pinnedSessions(sessions: Session[], limit = 6) {
  return sessions
    .filter((session) => session.pinned && !session.archived)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** The last active session is derived from local navigation order. Archived
 * sessions never become an implicit destination. */
export function lastActiveSessionId(
  sessions: readonly Session[],
  recentIds: readonly string[],
  current?: string,
) {
  return recentIds.find((id) =>
    id !== current && sessions.some((session) => session.id === id && !session.archived),
  );
}

export function nextSessionId(sessions: Session[], current: string, direction: -1 | 1) {
  const navigable = sessions.filter((session) => !session.archived);
  const index = navigable.findIndex((session) => session.id === current);
  if (index < 0 || navigable.length < 2) return;
  return navigable[(index + direction + navigable.length) % navigable.length]?.id;
}
