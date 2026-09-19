import type { Session } from "@threadterm/protocol";

export function manualSessionOrder(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((left, right) => {
    const project = (left.projectId ?? "").localeCompare(right.projectId ?? "");
    return project || (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.id.localeCompare(right.id);
  });
}

export function reorderProjectSessions(sessions: readonly Session[], sourceId: string, targetId: string): Session[] | undefined {
  const source = sessions.find((session) => session.id === sourceId);
  const target = sessions.find((session) => session.id === targetId);
  if (!source?.projectId || source.projectId !== target?.projectId || sourceId === targetId) return undefined;
  const group = manualSessionOrder(sessions.filter((session) => session.projectId === source.projectId));
  const from = group.findIndex((session) => session.id === sourceId);
  const to = group.findIndex((session) => session.id === targetId);
  if (from < 0 || to < 0) return undefined;
  const [moved] = group.splice(from, 1); group.splice(to, 0, moved);
  return group;
}

export function neighborProjectSession(sessions: readonly Session[], sessionId: string, direction: -1 | 1): string | undefined {
  const source = sessions.find((session) => session.id === sessionId);
  if (!source?.projectId) return undefined;
  const group = manualSessionOrder(sessions.filter((session) => session.projectId === source.projectId));
  const index = group.findIndex((session) => session.id === sessionId);
  return index < 0 ? undefined : group[index + direction]?.id;
}
