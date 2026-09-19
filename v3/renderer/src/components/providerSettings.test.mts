import assert from "node:assert/strict";
import test from "node:test";
import { accountProviders, signInTerminal } from "./providerSettings.js";

test("uses custom utility terminals so provider defaults cannot replace verified login commands", () => {
  assert.deepEqual(signInTerminal("codex"), { provider: "custom", executable: "cmd.exe", args: ["/D", "/S", "/C", "codex login"] });
  assert.deepEqual(signInTerminal("claude"), { provider: "custom", executable: "cmd.exe", args: ["/D", "/S", "/C", "claude auth login"] });
  assert.deepEqual(signInTerminal("kimi"), { provider: "custom", executable: "cmd.exe", args: ["/D", "/S", "/C", "kimi login"] });
  assert.deepEqual(signInTerminal("opencode"), { provider: "custom", executable: "cmd.exe", args: ["/D", "/S", "/C", "opencode providers login"] });
  assert.equal(signInTerminal("gemini"), undefined);
});

test("renders all five account providers when runtime capability data is incomplete", () => {
  const providers = accountProviders([{ id: "codex", name: "Codex", installed: true, terminal: true, chat: true, history: true, resume: true, auth: "authenticated" }]);
  assert.deepEqual(providers.map((provider) => provider.id), ["codex", "claude", "kimi", "gemini", "opencode"]);
  assert.equal(providers[1]?.installed, false);
  assert.equal(providers[1]?.auth, "unknown");
});
