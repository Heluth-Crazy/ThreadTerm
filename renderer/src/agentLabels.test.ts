import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderCapability } from "@threadterm/protocol";
import { attentionNotice, providerLabel } from "./attentionState";
import { connectionStatusText } from "./chatConnection";
import { paletteSessionDetail } from "./paletteSessions";

const providers: ProviderCapability[] = [{ id: "echo", name: "Echo Agent", installed: true, terminal: true, chat: true, history: false, resume: false }];

test("attention and reconnect notices display the registry name in both locales", () => {
  const attention = { id: "a", sessionId: "s", kind: "approval", provider: "echo" };
  assert.equal(providerLabel("echo", providers), "Echo Agent");
  assert.match(attentionNotice(attention, "en", undefined, providers).detail, /^Echo Agent /);
  assert.match(attentionNotice(attention, "zh-CN", undefined, providers).detail, /^Echo Agent · /);
  assert.equal(connectionStatusText("echo", "connecting", en => en, false, providers), "Connecting to Echo Agent…");
  assert.equal(connectionStatusText("echo", "failed", (_en, zh) => zh, false, providers), "无法连接到 Echo Agent。");
});

test("palette details include plugin names for search and keep legacy fallbacks", () => {
  const session = { id: "s", title: "Work", provider: "echo", mode: "terminal" as const, status: "idle" as const, createdAt: "", updatedAt: "" };
  assert.match(paletteSessionDetail(session, [], false, providers), /^Echo Agent · /);
  assert.equal(providerLabel("claude"), "Claude Code");
  assert.equal(providerLabel(undefined), "");
});
