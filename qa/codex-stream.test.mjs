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

test("Codex snapshots are delivered as visible cumulative frames", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next.parts[0]?.text ?? ""), 20);
  queue.push(item("A"));
  queue.push(item("AB"));
  queue.push(item("ABC", "complete"));
  assert.deepEqual(delivered, ["A"]);
  t.mock.timers.tick(10);
  assert.deepEqual(delivered, ["A"]);
  t.mock.timers.tick(10);
  assert.deepEqual(delivered, ["A", "AB"]);
  t.mock.timers.tick(20);
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

test("a long burst trails by a few snapshots, not by dozens", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next.parts[0]?.text ?? ""), 20);
  for (let index = 0; index < 40; index++) queue.push(streamingText(`frame-${index}`, "streaming"));
  assert.deepEqual(delivered.slice(0, 1), ["frame-0"], "the first frame paints at once");
  // At most three superseded frames wait for the animation; the next tick is already near the newest text.
  t.mock.timers.tick(20);
  assert.ok(Number(delivered.at(-1).slice("frame-".length)) >= 36, `trailing frame ${delivered.at(-1)}`);
  for (let step = 0; step < 10; step++) t.mock.timers.tick(20);
  assert.equal(delivered.at(-1), "frame-39");
  queue.dispose();
});

// A chat out of sight keeps only the newest text of a reply it already shows and paints it when shown again.
test("a hidden view parks the streaming text of a shown reply and paints only the newest on reveal", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let hidden = false;
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next.parts[0]?.text ?? ""), 20, () => hidden);
  queue.push(item("A"));
  hidden = true;
  queue.push(item("AB"));
  queue.push(item("ABC"));
  t.mock.timers.tick(200);
  assert.deepEqual(delivered, ["A"], "nothing repaints while hidden");
  hidden = false;
  queue.reveal();
  assert.deepEqual(delivered, ["A", "ABC"], "reveal paints the newest text once");
  queue.reveal();
  assert.deepEqual(delivered, ["A", "ABC"], "a second reveal has nothing left");
  queue.dispose();
});

test("a hidden view paints a new reply, approvals, tool cards and completions at once, in arrival order", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next), 20, () => true);
  const first = streamingText("first words", "streaming");
  queue.push(first);
  const approval = burstItem("approval-1", [{ type: "approval", approvalId: "approval-1", status: "pending" }]);
  queue.push(approval);
  const tool = burstItem("tool-1", [{ type: "tool", toolName: "commandExecution", toolId: "c1", status: "running" }]);
  queue.push(tool);
  // A running tool card is paced like any streaming item (one interval), hidden or not; it is never parked.
  t.mock.timers.tick(20);
  assert.deepEqual(delivered.map((entry) => entry.id), ["stream-1", "approval-1", "tool-1"], "first appearances keep their order");
  queue.push(streamingText("first words and more", "streaming"));
  t.mock.timers.tick(200);
  assert.equal(delivered.length, 3, "the shown reply's text waits");
  const done = streamingText("first words and more, done", "complete");
  queue.push(done);
  t.mock.timers.tick(200);
  assert.deepEqual(delivered.at(-1), done, "the completion supersedes the parked text");
  queue.reveal();
  assert.deepEqual(delivered.at(-1), done, "reveal never paints older text over the completion");
  queue.dispose();
});

test("two hidden replies each reveal their own newest text, and dispose drops parked text", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let hidden = false;
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(`${next.id}:${next.parts[0]?.text}`), 20, () => hidden);
  queue.push(burstItem("one", [{ type: "text", text: "1", status: "streaming" }]));
  t.mock.timers.tick(20);
  queue.push(burstItem("two", [{ type: "thinking", text: "2", status: "streaming" }]));
  t.mock.timers.tick(200);
  hidden = true;
  queue.push(burstItem("one", [{ type: "text", text: "1a", status: "streaming" }]));
  queue.push(burstItem("two", [{ type: "thinking", text: "2a", status: "streaming" }]));
  queue.push(burstItem("one", [{ type: "text", text: "1ab", status: "streaming" }]));
  hidden = false;
  queue.reveal();
  assert.deepEqual(delivered.slice(-2), ["one:1ab", "two:2a"]);
  hidden = true;
  queue.push(burstItem("one", [{ type: "text", text: "1abc", status: "streaming" }]));
  queue.dispose();
  queue.reveal();
  assert.equal(delivered.at(-1), "two:2a", "a disposed queue paints nothing");
});

test("when painting falls behind, a superseded snapshot that waited a whole interval is skipped", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next.parts[0]?.text ?? ""), 20);
  queue.push(item("A"));
  queue.push(item("AB"));
  queue.push(item("ABC"));
  // A slow paint keeps the main thread busy: the 20 ms timer runs 15 ms late.
  t.mock.timers.setTime(35);
  t.mock.timers.tick(0);
  assert.deepEqual(delivered, ["A", "ABC"], "AB waited 35 ms and ABC supersedes it");
  t.mock.timers.tick(20);
  // An idle queue paints the next snapshot at once; the ones behind it wait.
  queue.push(item("ABCD"));
  queue.push(item("ABCDE"));
  queue.push(item("ABCDEF", "complete"));
  assert.deepEqual(delivered, ["A", "ABC", "ABCD"]);
  t.mock.timers.setTime(Date.now() + 60);
  t.mock.timers.tick(0);
  assert.deepEqual(delivered, ["A", "ABC", "ABCD", "ABCDEF"], "the final state is never skipped");
  t.mock.timers.tick(100);
  assert.deepEqual(delivered, ["A", "ABC", "ABCD", "ABCDEF"]);
  queue.dispose();
});

test("a stream that painting keeps up with shows every snapshot", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(next.parts[0]?.text ?? ""), 20);
  queue.push(item("A"));
  queue.push(item("AB"));
  queue.push(item("ABC"));
  t.mock.timers.tick(20);
  t.mock.timers.tick(20);
  assert.deepEqual(delivered, ["A", "AB", "ABC"], "a short burst still animates frame by frame");
  queue.dispose();
});

test("catching up never skips the first snapshot of an item, so items keep the order they appeared in", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const delivered = [];
  const queue = createCodexStreamQueue((next) => delivered.push(`${next.id}:${next.parts[0]?.text ?? ""}`), 20);
  const streamingItem = (id, text) => ({ ...item(text), id });
  queue.push(streamingItem("x", "X"));
  t.mock.timers.setTime(1);
  queue.push(streamingItem("a", "A1"));
  t.mock.timers.setTime(2);
  queue.push(streamingItem("b", "B1"));
  t.mock.timers.setTime(3);
  queue.push(streamingItem("a", "A2"));
  t.mock.timers.setTime(25);
  t.mock.timers.tick(0);
  // Chained timers fire one tick at a time under the mock clock.
  for (let step = 0; step < 5; step++) t.mock.timers.tick(20);
  const firsts = [...new Set(delivered.map((entry) => entry.split(":")[0]))];
  assert.deepEqual(firsts, ["x", "a", "b"], "a appears before b, as it arrived");
  assert.ok(delivered.includes("a:A2") && delivered.includes("b:B1"), "every item ends on its newest snapshot");
  queue.dispose();
});
