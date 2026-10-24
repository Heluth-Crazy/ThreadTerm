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

const burstItem = (id, parts, role = "assistant") => ({ id, role, createdAt: "2026-09-13T00:00:00Z", parts });
const streamingText = (text, status) => burstItem("stream-1", [{ type: "text", text, status }]);

// A live view must converge on every item the runtime published, however wide
// the burst is. Nothing may be dropped to keep the animation budget.
const drain = async (delivered, done, limit = 4000) => {
  const deadline = Date.now() + limit;
  while (!done(delivered) && Date.now() < deadline) await wait(5);
};

test("a burst of 43 snapshots keeps every item id, its final state and the open approval", async () => {
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next), 5);
  const streaming = streamingText("partial answer", "streaming");
  const final = streamingText("final answer", "complete");
  const approval = burstItem("approval-1", [{ type: "approval", approvalId: "approval-1", status: "pending" }]);
  const tools = Array.from({ length: 40 }, (_, index) => burstItem(`tool-${index}`, [
    { type: "tool", toolName: "commandExecution", toolId: `command-${index}`, status: "completed" },
  ], "tool"));
  const burst = [streaming, final, approval, ...tools];
  assert.equal(burst.length, 43);
  for (const next of burst) queue.push(next);
  await drain(delivered, entries => [...tools, approval].every(entry => entries.some(deliveredItem => deliveredItem.id === entry.id))
    && entries.some(entry => entry.id === streaming.id && entry.parts[0]?.text === final.parts[0].text));
  const latest = new Map(delivered.map((entry) => [entry.id, entry]));
  assert.deepEqual(latest.get(streaming.id), final, "the streamed item reached its final state");
  assert.deepEqual(latest.get(approval.id), approval, "the pending approval survived the burst");
  for (const tool of tools) assert.deepEqual(latest.get(tool.id), tool, `${tool.id} survived the burst`);
  assert.deepEqual([...new Set(delivered.map((entry) => entry.id))], [streaming.id, approval.id, ...tools.map((tool) => tool.id)],
    "first appearance order matches the published order");
  assert.deepEqual(delivered.filter((entry) => entry.id === streaming.id).map((entry) => entry.parts[0].text),
    ["partial answer", "final answer"], "the streaming item keeps its paced frames");
  queue.dispose();
});

test("a wide burst of distinct streaming items delivers the only snapshot of every id", async () => {
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next), 5);
  const ids = Array.from({ length: 40 }, (_, index) => `wide-${index}`);
  for (const id of ids) queue.push(burstItem(id, [{ type: "text", text: `${id}-partial`, status: "streaming" }]));
  for (const id of ids) queue.push(burstItem(id, [{ type: "text", text: `${id}-final`, status: "complete" }]));
  await drain(delivered, entries => ids.every(id => entries.some(entry => entry.id === id && entry.parts[0].text === `${id}-final`)));
  for (const id of ids) {
    const latest = delivered.filter((entry) => entry.id === id).at(-1);
    assert.equal(latest?.parts[0].text, `${id}-final`, `${id} reached its final state`);
  }
  assert.deepEqual([...new Set(delivered.map((entry) => entry.id))], ids, "no item was discarded by the frame budget");
  queue.dispose();
});

test("a long single-item burst collapses superseded frames but ends on the latest snapshot", async () => {
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next), 5);
  const frames = Array.from({ length: 100 }, (_, index) => streamingText(`frame-${index}`, "streaming"));
  for (const frame of frames) queue.push(frame);
  const final = streamingText("frame-final", "complete");
  queue.push(final);
  await drain(delivered, entries => entries.at(-1)?.parts[0].text === "frame-final");
  assert.equal(delivered.at(-1)?.parts[0].text, "frame-final", "the latest snapshot is always delivered");
  assert.ok(delivered.length <= frames.length + 1, "superseded frames are collapsed, not accumulated");
  assert.deepEqual([...new Set(delivered.map((entry) => entry.id))], ["stream-1"]);
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
