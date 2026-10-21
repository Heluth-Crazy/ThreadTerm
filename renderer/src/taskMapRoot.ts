import type { Session } from '@threadterm/protocol';

/** The top-most delegating Chat above `sessionId` (itself when it was not delegated). */
export function taskMapRoot(sessionId: string, sessions: readonly Session[]): string {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const seen = new Set<string>();
  let current = sessionId;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = byId.get(current)?.delegation?.parentSessionId;
    if (!parent || !byId.has(parent) || seen.has(parent)) break;
    current = parent;
  }
  return current;
}
