import { test } from "node:test";
import assert from "node:assert/strict";
import { argumentLines, commandPreset } from "../renderer/src/commandPresets.ts";

test("argument lines preserve spaces and quotes as literal argv values", () => {
  assert.deepEqual(
    argumentLines('run\n--label=hello world\n"quoted value"\n'),
    ["run", "--label=hello world", '"quoted value"'],
  );
});

test("npm preset uses one explicit cmd command argument", () => {
  assert.deepEqual(commandPreset("npm"), {
    provider: "custom",
    executable: "cmd.exe",
    args: ["/D", "/S", "/C", "npm.cmd run dev"],
  });
});
