import { test } from "node:test";
import assert from "node:assert/strict";
import { neighborProjectSession, reorderProjectSessions } from "../renderer/src/sessionOrdering.ts";

const session = (id, projectId, sortOrder) => ({ id, projectId, sortOrder, title: id });
const rows = [session("a", "one", 1), session("b", "one", 2), session("c", "two", 1)];

test("reorders only the selected project's sessions", () => {
  assert.deepEqual(reorderProjectSessions(rows, "b", "a").map((row) => row.id), ["b", "a"]);
  assert.equal(reorderProjectSessions(rows, "a", "c"), undefined);
});

test("keyboard neighbors stay inside a project", () => {
  assert.equal(neighborProjectSession(rows, "a", 1), "b");
  assert.equal(neighborProjectSession(rows, "b", 1), undefined);
  assert.equal(neighborProjectSession(rows, "c", -1), undefined);
});
