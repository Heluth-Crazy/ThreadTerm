import assert from "node:assert/strict";
import test from "node:test";
import type { Group } from "@threadterm/protocol";
import { readLoadedGroupWindow } from "./groupHistory";

const message = (id: string, body = id) => ({ id, author: "user" as const, body, createdAt: `2026-01-01T00:00:0${id.slice(1)}Z` });
const page = (messages: Group["messages"], before?: string, hasMore = false, revision = 1): Group => ({ id: "group", revision, title: "Group", cwd: "/workspace", members: [], messages, lastRecipients: [], createdAt: "", updatedAt: "", before, hasMore });

test("uses one newest-page read when no older rendered boundary exists", async () => {
  const calls: unknown[] = [], newest = page([message("m2"), message("m3")], "m2", true);
  const result = await readLoadedGroupWindow(async params => { calls.push(params); return newest; });
  assert.equal(result, newest);
  assert.deepEqual(calls, [{}]);
});

test("refreshes an older active delivery through the loaded boundary without reading farther", async () => {
  const newest = page([message("m3"), message("m4")], "m3", true, 8);
  const older = page([{ ...message("m1"), deliveries: [{ sessionId: "s", handle: "agent", state: "replied" as const }] }, message("m2")], "m1", true, 7);
  const calls: { before?: string }[] = [];
  const result = await readLoadedGroupWindow(async params => { calls.push(params); return params.before ? older : newest; }, "m1");
  assert.deepEqual(calls, [{}, { before: "m3" }]);
  assert.deepEqual(result.messages.map(row => row.id), ["m1", "m2", "m3", "m4"]);
  assert.equal(result.messages[0].deliveries?.[0].state, "replied");
  assert.equal(result.revision, 8);
 assert.equal(result.before, "m3");
});

test("uses a newer revision observed while paging without replacing the newest-page cursor", async () => {
 const newest = page([message("m3")], "m3", true, 8), older = { ...page([message("m1")], "m1", false, 9), title: "Renamed" };
 const result = await readLoadedGroupWindow(async params => params.before ? older : newest, "m1");
 assert.equal(result.revision, 9);
 assert.equal(result.title, "Renamed");
 assert.equal(result.before, "m3");
});
