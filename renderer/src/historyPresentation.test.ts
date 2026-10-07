import assert from "node:assert/strict";
import test from "node:test";
import type { ChatItem } from "@threadterm/protocol";
import { historyChatPreview, historyOpenLabel, historyPreviewText, historyRenderablePart, historyToolStatus } from "./historyPresentation";

const en = (en: string, _zh: string) => en;
const zh = (_en: string, zh: string) => zh;
const item = (role: ChatItem["role"], parts: ChatItem["parts"]): ChatItem => ({ id: "fixture", role, parts, createdAt: "2026-10-07T00:00:00Z" });

test("history retains legacy string text without showing empty or structured debug parts", () => {
  assert.equal(historyRenderablePart({ type: "text", data: "Saved message" }), true);
  assert.equal(historyRenderablePart({ type: "text", text: "Saved message" }), true);
  assert.equal(historyRenderablePart({ type: "text", text: "", data: "shadowed text" }), false);
  assert.equal(historyRenderablePart({ type: "text", data: "" }), false);
  assert.equal(historyRenderablePart({ type: "text", data: { raw: "debug" } }), false);
  assert.equal(historyRenderablePart({ type: "usage", data: { tokens: 10 } }), false);
  assert.equal(historyRenderablePart({ type: "tool", toolName: "Read" }), true);
});

test("history preview selects the last conversation text, skipping thinking, tools and system records", () => {
  const items = [item("user", [{ type: "text", text: "Question" }]), item("assistant", [{ type: "text", text: "Answer\nLast line" }]),
    item("assistant", [{ type: "thinking", text: "Private reasoning" }]), item("tool", [{ type: "text", text: "tool output" }]),
    item("system", [{ type: "text", text: "system status" }])];
  assert.equal(historyChatPreview(items), "Answer\nLast line");
});

test("preview joins text chunks within a message without inventing newlines and supports legacy string data", () => {
  assert.equal(historyChatPreview([item("assistant", [{ type: "text", text: "hel" }, { type: "text", text: "lo" }, { type: "text", data: " world" }, { type: "tool", text: "ignored" }])]), "hello world");
  assert.equal(historyChatPreview([item("user", [{ type: "text", text: "Question" }]), item("assistant", [{ type: "text", text: " " }])]), "Question");
  assert.equal(historyChatPreview([item("assistant", [{ type: "text", data: { raw: "ignored" } }])]), "");
});

test("loading, empty, and failure previews are distinct in both locales", () => {
  const terminal = { mode: "terminal" as const }, chat = { mode: "chat" as const }, imported = { ...terminal, readOnly: true };
  assert.equal(historyPreviewText(chat, undefined, en), "Reading recent output…");
  assert.equal(historyPreviewText(chat, { complete: false, text: "" }, en), "Reading recent output…");
  assert.equal(historyPreviewText(terminal, { complete: true, text: "" }, en), "No output yet");
  assert.equal(historyPreviewText(chat, { complete: true, text: "\n " }, en), "No messages yet");
  assert.equal(historyPreviewText(imported, { complete: true }, en), "No messages yet");
  assert.equal(historyPreviewText(chat, { complete: false, issue: "Unavailable" }, en), "Unavailable");
  assert.equal(historyPreviewText(terminal, { complete: true, text: "" }, zh), "暂无输出");
  assert.equal(historyPreviewText(chat, { complete: true }, zh), "暂无消息");
  assert.equal(historyPreviewText(chat, { complete: true, text: "\nAnswer\n" }, en), "\nAnswer\n");
});

test("open actions describe session mode and give read-only transcripts priority", () => {
  assert.equal(historyOpenLabel({ mode: "terminal" }, en), "Open terminal");
  assert.equal(historyOpenLabel({ mode: "chat" }, en), "Open chat");
  assert.equal(historyOpenLabel({ mode: "terminal", readOnly: true }, en), "Open transcript");
  assert.equal(historyOpenLabel({ mode: "chat", readOnly: true }, en), "Open transcript");
  assert.equal(historyOpenLabel({ mode: "chat" }, zh), "打开 Chat");
  assert.equal(historyOpenLabel({ mode: "terminal", readOnly: true }, zh), "打开记录");
});

test("recorded tools have localized status summaries without exposing unknown protocol codes", () => {
  assert.equal(historyToolStatus("completed", en), "Completed");
  assert.equal(historyToolStatus("failed", en), "Failed");
  assert.equal(historyToolStatus("in_progress", en), "In progress");
  assert.equal(historyToolStatus("pending", zh), "待处理");
  assert.equal(historyToolStatus("cancelled", zh), "已取消");
  assert.equal(historyToolStatus("provider_specific", zh), "已记录");
  assert.equal(historyToolStatus(undefined, en), "Recorded");
});
