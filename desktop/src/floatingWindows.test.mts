import assert from "node:assert/strict";
import test from "node:test";
import { floatIdentity, nextFloatKey, tiledFloatBounds } from "./floatingWindows.js";

test("float identity reuses a session or workspace without creating a process", () => {
  assert.equal(floatIdentity({ sessionId: "s" }), "session:s");
  assert.equal(floatIdentity({ workspaceId: "w" }), "workspace:w");
  assert.equal(floatIdentity({}), undefined);
});
test("cycle and tile retain every existing floating window", () => {
  assert.equal(nextFloatKey(["a", "b"], "a"), "b");
  assert.equal(nextFloatKey(["a", "b"], "b"), "a");
  const tiles = tiledFloatBounds({ x: 0, y: 0, width: 1400, height: 900 }, 3);
  assert.equal(tiles.length, 3);
  assert.ok(tiles.every((tile) => tile.x + tile.width <= 1400 && tile.y + tile.height <= 900));
  const crowded = tiledFloatBounds({ x: 10, y: 20, width: 1040, height: 800 }, 7);
  assert.ok(crowded.every((tile) => tile.x >= 10 && tile.y >= 20 && tile.x + tile.width <= 1050 && tile.y + tile.height <= 820));
});
