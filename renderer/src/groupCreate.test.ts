import assert from "node:assert/strict";
import test from "node:test";
import { canCreateGroup, defaultGroupMembers, groupHandleIssue, previewGroupHandles } from "./groupCreate";

test("uses a single usable provider as the initial group member", () => {
  assert.deepEqual(defaultGroupMembers(["codex"]), [{ provider: "codex", handle: "", mode: "default" }]);
});

test("previews suffixes for repeated providers and validates explicit handles", () => {
  const members = [{ provider: "codex", handle: "", mode: "default" as const }, { provider: "codex", handle: "", mode: "read_only" as const }];
  assert.deepEqual(previewGroupHandles(members), ["codex", "codex-2"]);
  assert.equal(groupHandleIssue("All", ["all"], 0), "invalid");
  assert.equal(groupHandleIssue("codex", ["codex", "codex"], 0), "duplicate");
  assert.deepEqual(previewGroupHandles([{ provider: "codex", handle: "designer", mode: "default" }, { provider: "claude", handle: "designer", mode: "default" }]), ["designer", "designer"]);
  assert.equal(canCreateGroup(members, ["codex"]), true);
});
