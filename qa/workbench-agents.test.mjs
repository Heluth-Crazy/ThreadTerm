import assert from "node:assert/strict";
import test from "node:test";
import { workbenchAgentName, workbenchAgents } from "../renderer/src/components/workbenchAgents.ts";

const cap = (id, installed = true) => ({
  id,
  name: id,
  installed,
  terminal: true,
  chat: true,
  history: true,
  resume: true,
  auth: installed ? "authenticated" : "unknown",
});

test("lists every workbench agent even when runtime omits grok and uninstalled CLIs", () => {
  const agents = workbenchAgents([cap("codex"), cap("claude"), cap("gemini", false)], true);
  assert.deepEqual(
    agents.map((agent) => agent.id),
    ["codex", "claude", "kimi", "gemini", "opencode", "grok", "shell", "custom"],
  );
  assert.equal(agents.find((agent) => agent.id === "codex")?.available, true);
  assert.equal(agents.find((agent) => agent.id === "gemini")?.available, false);
  assert.equal(agents.find((agent) => agent.id === "gemini")?.hint, "未安装");
  assert.equal(agents.find((agent) => agent.id === "kimi")?.available, false);
  assert.equal(agents.find((agent) => agent.id === "grok")?.hint, "即将支持");
  assert.equal(agents.find((agent) => agent.id === "shell")?.available, true);
  assert.equal(agents.find((agent) => agent.id === "custom")?.available, true);
});

test("uses localized preset label and English not-installed hint", () => {
  assert.equal(workbenchAgentName("custom", true), "预设");
  assert.equal(workbenchAgentName("opencode", false), "OpenCode");
  const agents = workbenchAgents([], false);
  assert.equal(agents.find((agent) => agent.id === "claude")?.hint, "Not installed");
  assert.equal(agents.find((agent) => agent.id === "grok")?.hint, "Coming soon");
});
