import assert from "node:assert/strict";
import test from "node:test";
import { sameWorkspacePath } from "./workspacePath";

test("workspace paths preserve POSIX case while ignoring a trailing separator", () => {
  assert.equal(sameWorkspacePath("/Users/me/repo/", "/Users/me/repo"), true);
  assert.equal(sameWorkspacePath("/Users/me/repo", "/users/me/repo"), false);
});

test("workspace paths normalize Windows drive and UNC verbatim forms", () => {
  assert.equal(sameWorkspacePath("C:\\Repo\\App\\", "//?/c:/repo/app"), true);
  assert.equal(
    sameWorkspacePath("\\\\server\\share\\repo", "//?/UNC/server/share/REPO/"),
    true,
  );
  assert.equal(sameWorkspacePath("C:\\Repo\\one", "C:\\Repo\\two"), false);
});
