import assert from "node:assert/strict";
import test from "node:test";
import type { ChatConnectionError, ChatSessionOption } from "@threadterm/protocol";
import { permissionRestoreDetail } from "./permissionRecovery";
import { emptyLink, reduceChatLink } from "./chatConnection";

const en = (en: string) => en;
const zh = (_en: string, zh: string) => zh;
const sandbox: ChatSessionOption = { id: "sandbox", name: "Sandbox", category: "mode", value: "read-only", choices: [
  { value: "danger-full-access", name: "Full access" }, { value: "read-only", name: "Read only" },
] };
function failure(partial: Partial<NonNullable<ChatConnectionError["permissionRestore"]>> = {}): ChatConnectionError {
  return { code: "chat_permission_restore_failed", message: '{"native":"not a label"}', retryable: true,
    permissionRestore: { optionId: "sandbox", savedValue: "danger-full-access", reportedValue: "read-only", reason: "mismatch", ...partial } };
}

test("restore detail shows saved and reported catalogue labels in both languages", () => {
  assert.equal(permissionRestoreDetail(failure(), [sandbox], "Codex", en), "Sandbox: saved Full access; Codex reported Read only.");
  assert.equal(permissionRestoreDetail(failure(), [sandbox], "Codex", zh), "沙箱：已保存 完全访问；Codex 报告 只读。");
  assert.equal(permissionRestoreDetail(failure({ reportedValue: "workspace-write" }), [sandbox], "Codex", en), "Sandbox: saved Full access; Codex reported Workspace write.");
});

test("structured labels work before the failed catalogue arrives", () => {
  assert.equal(permissionRestoreDetail(failure(), [], "Codex", en), "Sandbox: saved Full access; Codex reported Read only.");
  assert.equal(permissionRestoreDetail(failure({ optionId: "custom", optionName: "Execution access", savedValue: "old", savedLabel: "Trusted", reportedValue: "new", reportedLabel: "Restricted" }), [], "Custom Agent", en), "Execution access: saved Trusted; Custom Agent reported Restricted.");
});

test("vanished settings name the option and provider without guessing the error message", () => {
  const error = failure({ optionId: "removed-setting", optionName: "Execution policy", reason: "missing", reportedValue: undefined });
  assert.equal(permissionRestoreDetail(error, [], "Permission QA", en), "Saved setting “Execution policy” is no longer offered by Permission QA.");
  assert.equal(permissionRestoreDetail(error, [], "Permission QA", zh), "Permission QA 已不再提供已保存的设置“Execution policy”。");
  assert.ok(permissionRestoreDetail(failure({ optionId: "vanished-id", reason: "missing" }), [], "Agent", en)?.includes("“vanished-id”"));
});

test("rejected settings remain specific without inventing a reported value", () => {
  assert.equal(permissionRestoreDetail(failure({ reason: "rejected", reportedValue: undefined }), [sandbox], "Codex", en), "Sandbox: Codex could not restore saved Full access.");
  assert.equal(permissionRestoreDetail(failure({ reason: "rejected", reportedValue: undefined }), [sandbox], "Codex", zh), "沙箱：Codex 无法恢复已保存的 完全访问。");
});

test("legacy errors get a visible safe fallback without parsing native text", () => {
  const error: ChatConnectionError = { code: "chat_permission_restore_failed", message: '{"api_key":"native detail"}', retryable: true };
  assert.equal(permissionRestoreDetail(error, [], "Agent", en), "Agent could not confirm the saved permission choice.");
  assert.equal(permissionRestoreDetail(error, [], "Agent", zh), "Agent 无法确认已保存的权限设置。");
  assert.equal(permissionRestoreDetail({ ...error, code: "auth_required" }, [], "Agent", en), undefined);
});

test("native labels are bounded, single-line, and never render raw JSON", () => {
  const text = permissionRestoreDetail(failure({ optionId: "x", optionName: "x".repeat(300), savedValue: "{\"private\":true}", reportedValue: "[1,2,3]" }), [], "Agent\nName", en)!;
  assert.ok(text.length < 240);
  assert.ok(text.includes("…"));
  assert.ok(text.includes("Unavailable"));
  assert.ok(!/[{}\[\]\n]/.test(text));
});

test("late connection rejection preserves structured restore evidence", () => {
  const state = emptyLink("session", "failed");
  state.connection.error = failure();
  const next = reduceChatLink(state, { type: "connect-failed", message: "RPC rejected" });
  assert.deepEqual(next.connection.error?.permissionRestore, state.connection.error.permissionRestore);
  assert.equal(permissionRestoreDetail(next.connection.error, [sandbox], "Codex", en), "Sandbox: saved Full access; Codex reported Read only.");
});
