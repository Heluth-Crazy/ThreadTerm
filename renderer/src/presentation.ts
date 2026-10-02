import type { PaneLayout, Session, Snapshot } from "@threadterm/protocol";

export type InitialRoute = {
  kind: "all" | "session" | "workspace";
  id?: string;
};

export function routeFromSearch(search: string): InitialRoute {
  const params = new URLSearchParams(search);
  const sessionId = params.get("sessionId");
  if (sessionId) return { kind: "session", id: sessionId };
  const workspaceId = params.get("workspaceId");
  return workspaceId ? { kind: "workspace", id: workspaceId } : { kind: "all" };
}

export function sessionIdFromLayout(layout: PaneLayout): string | undefined {
  if (layout.kind === "pane")
    return layout.tabs.find((tab) => tab.kind === "session")?.sessionId;
  return (
    sessionIdFromLayout(layout.first) ?? sessionIdFromLayout(layout.second)
  );
}

export function addSessionTab(
  layout: PaneLayout,
  sessionId: string,
): PaneLayout {
  if (layout.kind === "split")
    return { ...layout, first: addSessionTab(layout.first, sessionId) };
  if (
    layout.tabs.some(
      (tab) => tab.kind === "session" && tab.sessionId === sessionId,
    )
  )
    return layout;
  const id = `session-${sessionId}`;
  return {
    ...layout,
    tabs: [...layout.tabs, { id, kind: "session", sessionId }],
    activeTabId: layout.activeTabId,
  };
}

export function presentationRequest(
  value: unknown,
):
  | {
      sessionId: string;
      presentation: "background" | "focused";
      workspacePath?: string;
    }
  | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.sessionId !== "string" || !data.sessionId) return undefined;
  if (data.presentation !== "background" && data.presentation !== "focused")
    return undefined;
  return {
    sessionId: data.sessionId,
    presentation: data.presentation,
    workspacePath:
      typeof data.workspacePath === "string" ? data.workspacePath : undefined,
  };
}

export function sameWorkspace(
  session: Session,
  path: string | undefined,
): boolean {
  return !path || session.worktreePath === path;
}

/** Insert or replace a session in the current snapshot so create can open
 * the workspace before the next runtime refresh arrives. */
export function upsertSession(data: Snapshot, session: Session): Snapshot {
  const index = data.sessions.findIndex((item) => item.id === session.id);
  if (index < 0) return { ...data, sessions: [session, ...data.sessions] };
  const sessions = data.sessions.slice();
  sessions[index] = { ...sessions[index], ...session };
  return { ...data, sessions };
}

/** Session and workspace routes must never fall through to All terminals. */
export function sessionViewState(
  routeKind: string,
  session: Session | undefined,
): "ready" | "opening" | "none" {
  if (routeKind !== "session" && routeKind !== "workspace") return "none";
  return session ? "ready" : "opening";
}
