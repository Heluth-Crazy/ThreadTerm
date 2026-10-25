import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderCapability } from "@threadterm/protocol";
import { firstReadyAgent, providerReadiness } from "./providerReadiness";

const capability = (overrides: Partial<ProviderCapability> = {}): ProviderCapability => ({
  id: "codex",
  name: "Codex",
  installed: true,
  terminal: true,
  chat: true,
  history: true,
  resume: true,
  ...overrides,
});

test("classifies the requested mode and prefers Chat when both modes work", () => {
  const available = capability();
  assert.deepEqual(providerReadiness(available, "chat", false), { available: true, mode: "chat" });
  assert.deepEqual(providerReadiness(available, "terminal", false), { available: true, mode: "terminal" });
  assert.deepEqual(providerReadiness(available, "preferred", false), { available: true, mode: "chat" });
  assert.deepEqual(providerReadiness(capability({ chat: false }), "preferred", false), { available: true, mode: "terminal" });
});

test("keeps shell and custom terminal choices ready without a capability record", () => {
  assert.deepEqual(providerReadiness(capability({ id: "shell", installed: false, chat: false, terminal: false }), "preferred", false), { available: true, mode: "terminal" });
  assert.deepEqual(providerReadiness(capability({ id: "custom", installed: false, chat: false, terminal: false }), "chat", true), { available: true, mode: "terminal" });
});

test("gives a localized install or settings action for a missing provider", () => {
  assert.deepEqual(providerReadiness(capability({ installed: false, homepage: "https://example.test/install" }), "preferred", false), {
    available: false, mode: "chat", reason: "Not installed", action: "install", actionLabel: "Install…", homepage: "https://example.test/install",
  });
  assert.deepEqual(providerReadiness(capability({ installed: false }), "terminal", true), {
    available: false, mode: "terminal", reason: "未安装", action: "settings", actionLabel: "打开提供商设置",
  });
});

test("does not treat an absent capability as confirmation that a provider is not installed", () => {
  assert.deepEqual(providerReadiness(undefined, "chat", false), {
    available: false, mode: "chat", reason: "Provider status unavailable", action: "settings", actionLabel: "Open provider settings",
  });
  assert.deepEqual(providerReadiness(undefined, "preferred", true), {
    available: false, mode: "terminal", reason: "提供商状态不可用", action: "settings", actionLabel: "打开提供商设置",
  });
});

test("blocks explicit signed-out providers and directs to their existing sign-in command", () => {
  const signedOut = capability({ auth: "unauthenticated", signIn: { executable: "codex", args: ["login"], display: "codex login" } });
  assert.deepEqual(providerReadiness(signedOut, "terminal", false), {
    available: false, mode: "terminal", reason: "Signed out", action: "signIn", actionLabel: "Sign in",
  });
  assert.deepEqual(providerReadiness(capability({ auth: "unauthenticated" }), "preferred", true), {
    available: false, mode: "chat", reason: "未登录", action: "settings", actionLabel: "打开提供商设置",
  });
  assert.equal(providerReadiness(capability({ auth: "unknown" }), "preferred", false).available, true);
});

test("uses the provider reason for unsupported modes and exposes settings help", () => {
  assert.deepEqual(providerReadiness(capability({ chat: false, terminal: false, reason: "Requires version 2.0" }), "preferred", false), {
    available: false, mode: "terminal", reason: "Requires version 2.0", action: "settings", actionLabel: "Open provider settings",
  });
  assert.deepEqual(providerReadiness(capability({ chat: false }), "chat", true), {
    available: false, mode: "chat", reason: "不支持聊天模式", action: "settings", actionLabel: "打开提供商设置",
  });
});

test("finds the first ready registry agent while preferring Codex", () => {
  assert.equal(firstReadyAgent([capability({ id: "claude", name: "Claude" }), capability({ id: "codex", installed: false })]), "claude");
  assert.equal(firstReadyAgent([capability({ id: "claude", name: "Claude" }), capability({ id: "codex" })]), "codex");
  assert.equal(firstReadyAgent([capability({ id: "shell" }), capability({ id: "custom" }), capability({ id: "kimi", installed: false })]), undefined);
});
