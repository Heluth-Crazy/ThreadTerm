import assert from "node:assert/strict";
import test from "node:test";
import { lastActiveSessionId, visibleSessions } from "./navigation.js";

test("last active navigation skips the current and archived sessions", () => {
  const sessions = [
    { id: "current", archived: false },
    { id: "archived", archived: true },
    { id: "previous", archived: false },
  ] as never[];
  assert.equal(lastActiveSessionId(sessions, ["current", "archived", "previous"], "current"), "previous");
  assert.equal(lastActiveSessionId(sessions, ["current"], "current"), undefined);
});

test("active scope excludes an imported read-only idle session", () => {
  const sessions = [
    { id: "live", title: "live", provider: "shell", status: "idle", updatedAt: "2026-01-02T00:00:00Z" },
    { id: "imported", title: "imported", provider: "codex", status: "idle", readOnly: true, updatedAt: "2026-01-01T00:00:00Z" },
  ] as never[];
  assert.deepEqual(visibleSessions(sessions, "", "active", "updated").map((session) => session.id), ["live"]);
});
