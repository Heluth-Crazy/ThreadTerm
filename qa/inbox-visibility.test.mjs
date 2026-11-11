import assert from "node:assert/strict";
import test from "node:test";
import { inboxEventGroup, inboxKindLabel, isActionableInboxItem } from "../renderer/src/inboxVisibility.ts";

test("completed chat replies are not actionable inbox items", () => {
  assert.equal(isActionableInboxItem({ read: false, kind: "reply" }), false);
  assert.equal(isActionableInboxItem({ read: false, kind: "stalled" }), false);
  assert.equal(isActionableInboxItem({ read: false, kind: "approval" }), true);
  assert.equal(isActionableInboxItem({ read: true, kind: "approval" }), false);
  assert.equal(isActionableInboxItem({ read: false, kind: "error" }), true);
});

test("reply maps to review instead of the generic needs-attention fallback", () => {
  assert.equal(inboxEventGroup("reply"), "review");
  assert.equal(inboxKindLabel("reply", true), "待复核");
  assert.equal(inboxKindLabel("approval", true), "待确认");
});

test("a quiet delegate is actionable, filed under Input and labelled as no activity", () => {
  assert.equal(isActionableInboxItem({ read: false, kind: "quiet" }), true);
  assert.equal(inboxEventGroup("quiet"), "waiting");
  assert.equal(inboxKindLabel("quiet", false), "No activity");
  assert.equal(inboxKindLabel("quiet", true), "无活动");
});
