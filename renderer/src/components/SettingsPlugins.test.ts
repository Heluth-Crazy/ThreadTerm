import assert from "node:assert/strict";
import test from "node:test";
import { pluginCommandLines } from "./SettingsPlugins";

test("pluginCommandLines preserves every declared command in agent order", () => {
  assert.deepEqual(pluginCommandLines({ id: "echo", name: "Echo", version: "1.0.0", source: "user", enabled: false, issues: [], agents: [{ id: "echo", name: "Echo", terminal: true, chat: true, commands: ["node agent.mjs --version", "node agent.mjs", "node agent.mjs --acp"] }, { id: "echo-shell", name: "Echo shell", terminal: true, chat: false, commands: ["echo-shell"] }] }), ["node agent.mjs --version", "node agent.mjs", "node agent.mjs --acp", "echo-shell"]);
});

test("pluginCommandLines handles plugins with no agents or commands", () => {
  const plugin = { id: "empty", name: "Empty", version: "1.0", source: "user" as const, enabled: false, issues: [], agents: [] };
  assert.deepEqual(pluginCommandLines(plugin), []);
  assert.deepEqual(pluginCommandLines({ ...plugin, agents: [{ id: "empty", name: "Empty", terminal: true, chat: false, commands: [] }] }), []);
});
