import assert from "node:assert/strict";
import test from "node:test";
import { closestProjectForPath, displayPath, sessionsInProjectScope, unreadInboxInScope, sameCanonicalScope } from "./projectScope.js";

const sessions = [
  { id: "root", projectId: "p", title: "Root", provider: "codex", mode: "terminal", status: "idle", createdAt: "2026-09-10", updatedAt: "2026-09-10", worktreePath: "C:/Repo/" },
  { id: "tree", projectId: "p", title: "Tree", provider: "codex", mode: "terminal", status: "idle", createdAt: "2026-09-10", updatedAt: "2026-09-10", worktreePath: "C:\\Repo\\feature" },
  { id: "implicit", projectId: "p", title: "Implicit root", provider: "codex", mode: "terminal", status: "idle", createdAt: "2026-09-10", updatedAt: "2026-09-10" },
  { id: "other", projectId: "other", title: "Other", provider: "codex", mode: "terminal", status: "idle", createdAt: "2026-09-10", updatedAt: "2026-09-10", worktreePath: "C:\\Repo" },
] as const;

test("project and worktree scopes use canonical path identity", () => {
  assert.deepEqual(
    sessionsInProjectScope(sessions, "p", "c:\\repo", undefined).map((item) => item.id),
    ["root", "implicit"],
  );
  assert.deepEqual(
    sessionsInProjectScope(sessions, "p", "C:\\Repo", "C:/REPO/feature/").map((item) => item.id),
    ["tree"],
  );
});

test("pending inbox count only includes unread items owned by the visible scope", () => {
  const scoped = sessionsInProjectScope(sessions, "p", "C:\\Repo", undefined);
  assert.equal(unreadInboxInScope([
    { id: "unread", sessionId: "root", kind: "attention", title: "Root", createdAt: "2026-09-10", read: false },
    { id: "read", sessionId: "implicit", kind: "attention", title: "Implicit", createdAt: "2026-09-10", read: true },
    { id: "other", sessionId: "tree", kind: "attention", title: "Tree", createdAt: "2026-09-10", read: false },
    { id: "reply", sessionId: "root", kind: "reply", title: "Root", createdAt: "2026-09-10", read: false },
  ], scoped), 1);
});

test("native extended-length Windows paths match the selected display path", () => {
  assert.equal(sameCanonicalScope("\\\\?\\C:\\Repo", "c:/repo/"), true);
  assert.equal(sameCanonicalScope("\\\\?\\UNC\\server\\share\\repo", "\\\\SERVER\\SHARE\\repo"), true);
  assert.equal(sameCanonicalScope("\\server\\share", "\\\\server\\share"), false);
});

test("closest project for a cwd prefers the nested registered root", () => {
  const projects = [
    { id: "outer", path: "D:\\project\\ThreadTerm" },
    { id: "nested", path: "D:\\project\\ThreadTerm\\ThreadTerm-v3" },
  ];
  assert.equal(closestProjectForPath(projects, "D:\\project\\ThreadTerm\\ThreadTerm-v3\\v3")?.id, "nested");
  assert.equal(closestProjectForPath(projects, "D:\\project\\ThreadTerm")?.id, "outer");
  assert.equal(closestProjectForPath(projects, "E:\\other"), undefined);
});

test("displayPath hides Windows extended-length prefixes without changing ordinary paths", () => {
  assert.equal(displayPath("\\\\?\\D:\\project\\ThreadTerm\\ThreadTerm"), "D:\\project\\ThreadTerm\\ThreadTerm");
  assert.equal(displayPath("\\\\?\\UNC\\server\\share\\repo"), "\\\\server\\share\\repo");
  assert.equal(displayPath("//?/D:/repo"), "D:/repo");
  assert.equal(displayPath("//?/UNC/server/share/repo"), "//server/share/repo");
  assert.equal(displayPath("D:\\project\\ThreadTerm"), "D:\\project\\ThreadTerm");
  assert.equal(displayPath("/Users/me/project"), "/Users/me/project");
  assert.equal(displayPath(undefined), "");
});
