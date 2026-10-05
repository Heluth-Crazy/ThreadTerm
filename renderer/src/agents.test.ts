import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderCapability } from "@threadterm/protocol";
import { agentIds, agentName } from "./agents";

const capability = (id: string, name = ""): ProviderCapability => ({ id, name, installed: true, terminal: true, chat: true, history: true, resume: true });

test("orders registered built-ins before plugin agents by display name without mutating capabilities", () => {
  const providers = [capability("z-agent", "Alpha"), capability("custom"), capability("grok"), capability("opencode"), capability("gemini"), capability("shell"), capability("kimi"), capability("claude"), capability("codex"), capability("a-agent", "Zulu")];
  const before = [...providers];
  assert.deepEqual(agentIds(providers), ["codex", "claude", "kimi", "gemini", "opencode", "grok", "z-agent", "a-agent"]);
  assert.deepEqual(providers, before);
  assert.deepEqual(agentIds([]), []);
  assert.deepEqual(agentIds([capability("echo"), capability("echo")]), ["echo"]);
});

test("uses capability names and keeps known and unknown name fallbacks", () => {
  assert.equal(agentName("echo", [capability("echo", "Echo Agent")]), "Echo Agent");
  assert.equal(agentName("claude", [capability("claude", "Claude Registry")]), "Claude Registry");
  assert.equal(agentName("claude", [capability("claude", "  ")]), "Claude Code");
  assert.equal(agentName("opencode"), "OpenCode");
  assert.equal(agentName("codex"), "Codex");
  assert.equal(agentName("new-agent"), "New-agent");
  assert.equal(agentName(""), "");
});

test("plugin name ties have a deterministic id order", () => {
  assert.deepEqual(agentIds([capability("z-agent", "Echo"), capability("a-agent", "echo")]), ["a-agent", "z-agent"]);
});
