import assert from "node:assert/strict";
import test from "node:test";
import { connectionWorkingDirectory } from "./ChatConnectionChip";

test("the connection popover displays the user-facing path, not the verbatim runtime form", () => {
  assert.equal(connectionWorkingDirectory("\\\\?\\C:\\Users\\me\\project"), "C:\\Users\\me\\project");
  assert.equal(connectionWorkingDirectory("\\\\?\\UNC\\server\\share\\repo"), "\\\\server\\share\\repo");
  assert.equal(connectionWorkingDirectory("C:\\Users\\me\\project"), "C:\\Users\\me\\project");
  assert.equal(connectionWorkingDirectory(undefined), "");
});
