import type { Project, Session } from "@threadterm/protocol";
import { providerLabel } from "./attentionState";
import { displayPath, sameCanonicalScope } from "./projectScope";
import { isTerminalAttentionSession, sessionActivity, sessionActivityLabel, sortSessionsByActivity } from "./sessionActivity";
import { sessionState, sessionStateLabel, type SessionViewState } from "./sessionState";

const time = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };

/**
 * The command palette's session order, captured once when it opens: live sessions by attention (what waits for
 * the user first, sessionActivity.ts), then ended, read-only and archived ones, most recently updated first.
 */
export function paletteOrder(sessions: readonly Session[]): Map<string, number> {
  const live = sessions.filter(session => !session.archived && !isTerminalAttentionSession(session));
  const rest = sessions.filter(session => !live.includes(session))
    .sort((left, right) => time(right.updatedAt) - time(left.updatedAt) || left.id.localeCompare(right.id));
  return new Map([...sortSessionsByActivity(live), ...rest].map((session, index) => [session.id, index]));
}

/** Sessions in the captured order, so rows never move under the pointer; sessions created since come last. */
export function orderedPaletteSessions<T extends Session>(sessions: readonly T[], order: ReadonlyMap<string, number>): T[] {
  const at = (session: Session) => order.get(session.id) ?? Number.MAX_SAFE_INTEGER;
  return [...sessions].sort((left, right) => at(left) - at(right) || time(right.createdAt) - time(left.createdAt) || left.id.localeCompare(right.id));
}

/** Dot tone and wording: a live session's activity when it is known, otherwise the shared session state. */
export function paletteSessionState(session: Session, zh: boolean): { tone: SessionViewState; label: string } {
  const activity = sessionActivity(session);
  if (!isTerminalAttentionSession(session) && activity !== "unknown") {
    return { tone: activity === "awaiting_approval" || activity === "awaiting_input" ? "needs" : "running", label: sessionActivityLabel(activity, zh) };
  }
  const tone = sessionState(session);
  return { tone, label: sessionStateLabel(tone, zh, session.readOnly) };
}

/** "Codex · Awaiting approval · ThreadTerm · feature-x": provider, state, project, and the worktree folder when the
 * session works outside the project's main folder. */
export function paletteSessionDetail(session: Session, projects: readonly Project[], zh: boolean): string {
  const project = projects.find(candidate => candidate.id === session.projectId);
  const worktree = session.worktreePath && !(project && sameCanonicalScope(session.worktreePath, project.path))
    ? displayPath(session.worktreePath).replace(/[\\/]+$/, "").split(/[\\/]/).at(-1)
    : undefined;
  return [providerLabel(session.provider), paletteSessionState(session, zh).label, project?.name, worktree].filter(Boolean).join(" · ");
}
