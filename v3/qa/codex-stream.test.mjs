import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodexStreamQueue } from "../renderer/src/codexStream.ts";

const item = (text, status = "streaming") => ({
  id: "assistant-1",
  role: "assistant",
  createdAt: "2026-09-13T00:00:00Z",
  parts: [{ type: "text", text, status }],
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Codex snapshots are delivered as visible cumulative frames", async () => {
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next.parts[0]?.text ?? ""), 20);
  queue.push(item("A"));
  queue.push(item("AB"));
  queue.push(item("ABC", "complete"));
  assert.deepEqual(delivered, ["A"]);
  await wait(10);
  assert.deepEqual(delivered, ["A"]);
  await wait(20);
  assert.deepEqual(delivered, ["A", "AB"]);
  await wait(20);
  assert.deepEqual(delivered, ["A", "AB", "ABC"]);
  queue.dispose();
});

test("non-streaming items from other turns are delivered immediately", () => {
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next.id), 5);
  queue.push({ ...item("user", "complete"), id: "user-1", role: "user" });
  assert.deepEqual(delivered, ["user-1"]);
  queue.dispose();
});

test("disposing a queue prevents delayed frames from updating the view", async () => {
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next.parts[0]?.text ?? ""), 5);
  queue.push(item("A"));
  queue.push(item("AB"));
  queue.dispose();
  await wait(30);
  assert.deepEqual(delivered, ["A"]);
});
