import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderCapability } from "@threadterm/protocol";
import { workbenchAgents, workbenchAgentName } from "./components/workbenchAgents";

const capability = (id: string, name: string, installed = true): ProviderCapability => ({ id, name, installed, terminal: true, chat: false, history: false, resume: false });

test("workbench includes installed plugins and retains shell and preset positions", () => {
  const providers = [capability("echo", "Echo plugin"), capability("codex", "Codex"), capability("absent", "Absent plugin", false)];
  assert.deepEqual(workbenchAgents(providers, false), [
    { id: "codex", name: "Codex", available: true },
    { id: "absent", name: "Absent plugin", available: false, hint: "Not installed" },
    { id: "echo", name: "Echo plugin", available: true },
    { id: "shell", name: "Shell", available: true },
    { id: "custom", name: "Preset", available: true },
  ]);
  assert.equal(workbenchAgents(providers, true)[1].hint, "未安装");
  assert.equal(workbenchAgentName("custom", true), "预设");
  assert.equal(workbenchAgentName("echo", false, providers), "Echo plugin");
  assert.equal(workbenchAgentName("claude", false), "Claude Code");
});

test("empty registry offers only shell and preset instead of disabled plugin entries", () => {
  assert.deepEqual(workbenchAgents([], false).map(agent => agent.id), ["shell", "custom"]);
});

test("chat-only plugins cannot launch terminals from the workbench", () => {
  const providers = [{ ...capability("echo", "Echo"), terminal: false, chat: true }];
  assert.equal(workbenchAgents(providers, false)[0].available, false);
  assert.equal(workbenchAgents(providers, false)[0].hint, "Terminal unavailable");
  assert.equal(workbenchAgents(providers, true)[0].hint, "不支持终端");
});
