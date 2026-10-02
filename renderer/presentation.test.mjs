import assert from "node:assert/strict";
import test from "node:test";
import {
  addSessionTab,
  presentationRequest,
  routeFromSearch,
  sessionIdFromLayout,
  sessionViewState,
  upsertSession,
} from "./src/presentation.ts";
const pane = {
  kind: "pane",
  id: "p",
  tabs: [{ id: "session-a", kind: "session", sessionId: "a" }],
  activeTabId: "session-a",
};
test("float URL selects session before a workspace", () => {
  assert.deepEqual(routeFromSearch("?workspaceId=w&sessionId=s"), {
    kind: "session",
    id: "s",
  });
  assert.deepEqual(routeFromSearch("?workspaceId=w"), {
    kind: "workspace",
    id: "w",
  });
});
test("background presentation adds a tab without changing active tab", () => {
  const next = addSessionTab(pane, "b");
  assert.equal(next.activeTabId, "session-a");
  assert.equal(sessionIdFromLayout(next), "a");
  assert.equal(next.tabs.length, 2);
  assert.equal(addSessionTab(next, "b").tabs.length, 2);
});
test("presentation request rejects malformed payloads", () => {
  assert.equal(
    presentationRequest({ sessionId: "x", presentation: "focused" })?.sessionId,
    "x",
  );
  assert.equal(
    presentationRequest({ sessionId: "x", presentation: "other" }),
    undefined,
  );
});
const stamp = "2026-09-16T00:00:00Z";
const created = {
  id: "new",
  title: "New",
  provider: "codex",
  mode: "chat",
  status: "starting",
  createdAt: stamp,
  updatedAt: stamp,
};
const snapshot = {
  epoch: "e",
  revision: 1,
  projects: [],
  sessions: [
    {
      id: "old",
      title: "Old",
      provider: "shell",
      mode: "terminal",
      status: "running",
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
  settings: { revision: 1 },
  workspaces: [],
  presets: [],
  inbox: [],
  providers: [],
};
test("created sessions open as a workspace, never as all terminals", () => {
  assert.equal(sessionViewState("session", undefined), "opening");
  assert.equal(sessionViewState("workspace", undefined), "opening");
  assert.equal(sessionViewState("session", created), "ready");
  assert.equal(sessionViewState("all", created), "none");
  assert.equal(sessionViewState("workbench", undefined), "none");
  assert.equal(sessionViewState("inbox", undefined), "none");
});
test("create upserts the returned session before the next snapshot", () => {
  const inserted = upsertSession(snapshot, created);
  assert.equal(inserted.sessions[0].id, "new");
  assert.equal(inserted.sessions.length, 2);
  const renamed = upsertSession(inserted, { ...created, title: "Renamed", status: "idle" });
  assert.equal(renamed.sessions.length, 2);
  assert.equal(renamed.sessions.find((item) => item.id === "new")?.title, "Renamed");
  assert.equal(renamed.sessions.find((item) => item.id === "new")?.status, "idle");
});
