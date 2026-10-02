import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionFromEvent, attentionNotice, shouldPresentAttention } from "../renderer/src/attentionState.ts";

test("attention ignores malformed and stale duplicate events", () => {
  const seen = new Set();
  assert.equal(attentionFromEvent({ event: "state.changed", data: {} }), undefined);
  const attention = attentionFromEvent({ event: "inbox.created", data: { id: "reply:1", sessionId: "s", kind: "reply" } });
  assert.ok(attention);
  assert.equal(shouldPresentAttention({ attention, routeKind: "all", initialized: false, seen }), false);
  assert.equal(shouldPresentAttention({ attention, routeKind: "all", initialized: true, seen }), false);
});

test("attention is suppressed while inbox is open and otherwise presents once", () => {
  const suppressed = { id: "reply:2", sessionId: "s", kind: "reply" };
  assert.equal(shouldPresentAttention({ attention: suppressed, routeKind: "inbox", initialized: true, seen: new Set() }), false);
  const seen = new Set();
  assert.equal(shouldPresentAttention({ attention: { id: "error:3", sessionId: "s", kind: "error" }, routeKind: "all", initialized: true, seen }), true);
  assert.equal(shouldPresentAttention({ attention: { id: "error:3", sessionId: "s", kind: "error" }, routeKind: "all", initialized: true, seen }), false);
});

test("attention names the session and is not toasted on that session's view", () => {
  const attention = attentionFromEvent({
    event: "inbox.created",
    data: { id: "reply:4", sessionId: "sess-kimi", kind: "reply", title: "测试会话", provider: "kimi" },
  });
  assert.ok(attention);
  assert.equal(attention.title, "测试会话");
  assert.equal(attention.provider, "kimi");
  assert.equal(shouldPresentAttention({ attention, routeKind: "session", routeId: "sess-kimi", initialized: true, seen: new Set() }), false);
  assert.equal(shouldPresentAttention({ attention, routeKind: "session", routeId: "other", initialized: true, seen: new Set() }), true);
  const notice = attentionNotice(attention, "zh-CN");
  assert.equal(notice.heading, "测试会话");
  assert.match(notice.detail, /Kimi/);
  assert.match(notice.detail, /结构化回复/);
  assert.equal(notice.action, "打开会话");
});
