import assert from "node:assert/strict";
import test from "node:test";
import { activeTurnId, chatCanControl, formatChatDuration, itemShowsStreaming, matchSlashCommands, partBody, partLabel, shouldRenderPart, slashQuery } from "../renderer/src/chatPresentation.ts";

const copy = (_en, zh) => zh;

test("interrupted and failed chat sessions remain controllable", () => {
  assert.equal(chatCanControl({ status: "idle" }), true);
  assert.equal(chatCanControl({ status: "interrupted" }), true);
  assert.equal(chatCanControl({ status: "error" }), true);
  assert.equal(chatCanControl({ status: "exited" }), false);
  assert.equal(chatCanControl({ status: "idle", readOnly: true }), false);
});

test("text parts render body without a type label", () => {
  const part = { type: "text", text: "hello" };
  assert.equal(shouldRenderPart(part), true);
  assert.equal(partLabel(part, copy), undefined);
  assert.equal(partBody(part), "hello");
});

test("usage parts stay out of the transcript and tools keep their names", () => {
  assert.equal(shouldRenderPart({ type: "usage", data: { inputTokens: 1 } }), false);
  assert.equal(partLabel({ type: "tool", toolName: "Read" }, copy), "Read");
  assert.equal(partLabel({ type: "approval", approvalId: "a", status: "pending" }, copy), "需要批准");
});

test("structured status parts render as a card without a generic type label", () => {
  const part = { type: "status", status: "complete", text: "Codex session status", data: { model: "gpt-5.5-luna" } };
  assert.equal(shouldRenderPart(part), true);
  assert.equal(partLabel(part, copy), undefined);
  assert.equal(partBody(part), "Codex session status");
});

test("thinking parts render without a type label and count as in-flight while streaming", () => {
  const streaming = { type: "thinking", text: "plan", status: "streaming" };
  assert.equal(shouldRenderPart(streaming), true);
  assert.equal(partLabel(streaming, copy), undefined);
  assert.equal(partBody(streaming), "plan");
  assert.equal(shouldRenderPart({ type: "thinking", text: "", status: "complete" }), false);
});

test("only the latest unanswered assistant message shows a streaming caret", () => {
  const first = { id: "a1", role: "assistant", createdAt: "1", parts: [{ type: "text", text: "hi", status: "streaming" }] };
  const user = { id: "u2", role: "user", createdAt: "2", parts: [{ type: "text", text: "who" }] };
  const second = { id: "a3", role: "assistant", createdAt: "3", parts: [{ type: "text", text: "ok", status: "streaming" }] };
  assert.equal(itemShowsStreaming(first, [first, user]), false);
  assert.equal(itemShowsStreaming(second, [first, user, second]), true);
  assert.equal(slashQuery("/st"), "st");
  assert.equal(slashQuery("/stop now"), undefined);
  assert.deepEqual(matchSlashCommands("st", [{ name: "stop" }, { name: "status" }, { name: "help" }]).map((item) => item.name), ["stop", "status"]);
});

test("formats chat turn duration like the grok transcript header", () => {
  assert.equal(formatChatDuration(70_000, true), "用时 1m 10s");
  assert.equal(formatChatDuration(4_200, true), "用时 4s");
  assert.equal(formatChatDuration(70_000, false), "1m 10s");
});

test("only in-flight turns expose a stop target", () => {
  const items = [
    { id: "1", role: "user", createdAt: "now", turnId: "t1", parts: [{ type: "text", text: "hi" }] },
    { id: "2", role: "assistant", createdAt: "now", turnId: "t2", parts: [{ type: "thinking", text: "plan", status: "streaming" }] },
  ];
  assert.equal(activeTurnId(items), "t2");
  items[1].parts[0].status = "completed";
  assert.equal(activeTurnId(items), undefined);
});

test('reopened idle and completed turns cannot inherit stale streaming stop targets', () => {
  const stale = {id:'old',role:'assistant',turnId:'old-turn',parts:[{type:'text',text:'Done',status:'streaming'}]};
  for (const status of ['idle','error','interrupted','exited']) assert.equal(activeTurnId([stale], status), undefined);
  const completed = {id:'done',role:'assistant',turnId:'old-turn',parts:[],elapsedMs:9000};
  assert.equal(activeTurnId([stale,completed]), undefined);
  assert.equal(activeTurnId([stale,completed], 'running'), undefined, 'completion beats a delayed session snapshot');
  assert.equal(itemShowsStreaming(stale,[stale,completed]),false);
  const next = {id:'next',role:'user',turnId:'new-turn',parts:[{type:'text',text:'Hello'}]};
  assert.equal(activeTurnId([stale,next]),undefined, 'a new user boundary cannot reactivate an old turn');
  assert.equal(activeTurnId([stale,completed,next],'running'),'new-turn', 'a real running turn can be stopped before its first token');
  assert.equal(activeTurnId([stale,completed,next],'waiting'),'new-turn');
});
