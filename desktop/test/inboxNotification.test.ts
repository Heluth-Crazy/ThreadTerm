import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxNotificationCopy, notificationLocale, terminalNotificationCopy, terminalNotificationKind, testNotificationCopy } from "../src/inboxNotification.ts";

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

test("notifications follow the app language: Chinese only when chosen, English by default", () => {
  assert.equal(notificationLocale({ language: "zh-CN" }), "zh-CN");
  assert.equal(notificationLocale({ language: "en" }), "en");
  assert.equal(notificationLocale({}), "en");
  assert.equal(notificationLocale(undefined), "en");
  const approval = inboxNotificationCopy({ kind: "waiting", title: "修复登录", provider: "claude" }, "zh-CN");
  assert.deepEqual(approval, { title: "修复登录", body: "Claude Code · 修复登录：正在等待你的批准。" });
  const error = inboxNotificationCopy({ kind: "error" }, "zh-CN");
  assert.deepEqual(error, { title: "ThreadTerm 需要你处理", body: "提供方请求失败。" });
});

test("English inbox copy is unchanged for existing callers", () => {
  assert.deepEqual(inboxNotificationCopy({ kind: "error", title: "Build", provider: "opencode" }), { title: "Build", body: "OpenCode · Build had a provider request fail." });
  assert.deepEqual(inboxNotificationCopy({ kind: "reply" }), { title: "ThreadTerm reply ready", body: "A provider reply is ready." });
});

test("notifications use the registry provider name when it is available", () => {
  assert.deepEqual(inboxNotificationCopy({ kind: "reply", title: "Echo", provider: "echo", providerName: "Echo (ACP example)" }), { title: "Echo", body: "Echo (ACP example) · Echo has a new structured reply." });
  assert.deepEqual(terminalNotificationCopy({ status: "exited", exitCode: 0, title: "Echo", provider: "echo", providerName: "Echo (ACP example)" }), { title: "Echo", body: "Echo (ACP example) · Echo finished." });
});

test("terminal notices name the session and say how it ended, like the runtime's exit inbox kinds", () => {
  const clean = { status: "exited", exitCode: 0, title: "npm test", provider: "shell" };
  assert.deepEqual(terminalNotificationCopy(clean), { title: "npm test", body: "Shell · npm test finished." });
  assert.equal(terminalNotificationKind(clean), "completed");
  const failing = { status: "exited", exitCode: 3, title: "npm test", provider: "shell" };
  assert.deepEqual(terminalNotificationCopy(failing), { title: "npm test", body: "Shell · npm test exited with code 3." });
  assert.deepEqual(terminalNotificationCopy(failing, "zh-CN"), { title: "npm test", body: "Shell · npm test：以退出码 3 结束。" });
  assert.equal(terminalNotificationKind(failing), "attention");
  assert.equal(terminalNotificationKind({ status: "exited", exitCode: null }), "attention");
  assert.deepEqual(terminalNotificationCopy({ status: "exited" }), { title: "Terminal session needs attention", body: "The terminal session was interrupted." });
  assert.deepEqual(terminalNotificationCopy({ status: "error" }), { title: "Terminal session needs attention", body: "The terminal session failed." });
  assert.deepEqual(terminalNotificationCopy({ status: "interrupted", title: "dev server" }, "zh-CN"), { title: "dev server", body: "dev server：被中断。" });
  assert.equal(testNotificationCopy("zh-CN").title, "ThreadTerm 通知已开启");
  assert.match(testNotificationCopy().body, /Click a notification/);
});
