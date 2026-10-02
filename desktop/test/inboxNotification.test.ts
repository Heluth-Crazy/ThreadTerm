import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxNotificationCopy } from "../src/inboxNotification.ts";

test("native inbox copy names the session that needs action", () => {
  const reply = inboxNotificationCopy({ kind: "reply", title: "测试会话", provider: "kimi" });
  assert.equal(reply.title, "测试会话");
  assert.match(reply.body, /Kimi/);
  assert.match(reply.body, /测试会话/);
  assert.match(reply.body, /structured reply/);
  const approval = inboxNotificationCopy({ kind: "approval", title: "Review", provider: "codex" });
  assert.equal(approval.title, "Review");
  assert.match(approval.body, /approval/);
});
