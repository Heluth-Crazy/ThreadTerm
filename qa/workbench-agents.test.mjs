import assert from "node:assert/strict";
import test from "node:test";
import { workbenchAgentName, workbenchAgents } from "../renderer/src/components/workbenchAgents.ts";

const cap = (id, { installed = true, terminal = installed } = {}) => ({
  id,
  name: id,
  installed,
  terminal,
  chat: true,
  history: true,
  resume: true,
  auth: installed ? "authenticated" : "unknown",
});

test("lists only reported built-ins and enabled plugins alongside Shell and Preset", () => {
  const agents = workbenchAgents([
    cap("codex"),
    cap("claude", { installed: false }),
    cap("gemini", { terminal: false }),
    cap("grok"),
    cap("echo"),
  ], true);
  assert.deepEqual(
    agents.map((agent) => agent.id),
    ["codex", "claude", "gemini", "grok", "echo", "shell", "custom"],
  );
  assert.equal(agents.find((agent) => agent.id === "codex")?.available, true);
  assert.equal(agents.find((agent) => agent.id === "claude")?.available, false);
  assert.equal(agents.find((agent) => agent.id === "claude")?.hint, "未安装");
  assert.equal(agents.find((agent) => agent.id === "gemini")?.available, false);
  assert.equal(agents.find((agent) => agent.id === "gemini")?.hint, "不支持终端");
  assert.equal(agents.find((agent) => agent.id === "grok")?.available, true, "Grok is a live provider when runtime reports it available");
  assert.equal(agents.find((agent) => agent.id === "echo")?.available, true, "reported enabled plugin is listed and usable");
  assert.equal(agents.some((agent) => ["kimi", "opencode"].includes(agent.id)), false, "omitted providers are not fabricated as unavailable entries");
  assert.equal(agents.find((agent) => agent.id === "shell")?.available, true);
  assert.equal(agents.find((agent) => agent.id === "custom")?.available, true);
});

test("empty pending capabilities list only immediately usable Shell and Preset", () => {
  const agents = workbenchAgents([], false);
  assert.deepEqual(agents.map((agent) => agent.id), ["shell", "custom"]);
  assert.equal(agents.every((agent) => agent.available), true);
  assert.equal(agents.some((agent) => agent.hint), false, "pending native discovery makes no installed or missing claim");
});

test("localizes confirmed missing and terminal-unavailable hints", () => {
  assert.equal(workbenchAgentName("custom", true), "预设");
  assert.equal(workbenchAgentName("opencode", false), "OpenCode");
  const agents = workbenchAgents([
    cap("claude", { installed: false }),
    cap("gemini", { terminal: false }),
  ], false);
  assert.equal(agents.find((agent) => agent.id === "claude")?.hint, "Not installed");
  assert.equal(agents.find((agent) => agent.id === "gemini")?.hint, "Terminal unavailable");
});
