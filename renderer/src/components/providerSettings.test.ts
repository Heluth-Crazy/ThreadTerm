import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderCapability } from "@threadterm/protocol";
import { accountProviders, signInTerminal } from "./providerSettings";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import { providerReadiness } from "../providerReadiness";
import type { Snapshot } from "@threadterm/protocol";

const capability = (id: string, installed = true): ProviderCapability => ({ id, name: id, installed, terminal: true, chat: true, history: true, resume: true });

test("uses resolved capability commands in custom terminals without rewriting arguments", () => {
  const signIn = { executable: "C:/Plugin folder/echo.cmd", args: ["login", "a quoted argument"], display: "echo login" };
  const provider = { ...capability("echo"), signIn };
  const command = signInTerminal(provider);
  assert.deepEqual(command, { provider: "custom", executable: signIn.executable, args: signIn.args });
  assert.notEqual(command!.args, signIn.args);
  assert.equal(signInTerminal({ ...provider, installed: false }), undefined);
  assert.equal(signInTerminal(capability("gemini")), undefined);
});

test("account providers come from the registry and include plugin sign-in agents", () => {
  const providers = accountProviders([{ ...capability("echo"), name: "Echo Agent", source: "plugin", signIn: { executable: "echo", args: ["login"], display: "echo login" } }, { ...capability("claude", false), name: "" }, capability("shell"), capability("custom")]);
  assert.deepEqual(providers.map(provider => provider.id), ["claude", "echo"]);
  assert.equal(providers[0].name, "Claude Code");
  assert.equal(providers[0].installed, false);
  assert.equal(providers[1].name, "Echo Agent");
  assert.deepEqual(accountProviders([]), []);
});


test("remote commands apply only to another computer and fall back to the local command", () => {
  const signIn = { executable: "codex", args: ["login"], display: "codex login" };
  const remoteSignIn = { ...signIn, args: ["login", "--device-auth"] };
  const provider = { ...capability("codex"), signIn, remoteSignIn };
  assert.deepEqual(signInTerminal(provider, false)?.args, ["login"]);
  assert.deepEqual(signInTerminal(provider, true)?.args, ["login", "--device-auth"]);
  assert.deepEqual(signInTerminal({ ...provider, remoteSignIn: undefined }, true)?.args, ["login"]);
  assert.equal(signInTerminal({ ...provider, installed: false }, true), undefined);
  const grok = { ...capability("grok"), remoteSignIn };
  assert.equal(signInTerminal(grok, false), undefined);
  assert.deepEqual(signInTerminal(grok, true)?.args, ["login", "--device-auth"]);
});


test("all callers use the view default, including readiness for remote-only Grok", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    const provider = { ...capability("grok"), auth: "unauthenticated" as const, remoteSignIn: { executable: "grok", args: ["login", "--device-auth"], display: "grok login --device-auth" } };
    for (const machineId of ["local", "office-pc"]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { threadterm: { machineId } } });
      assert.equal(Boolean(signInTerminal(provider)), machineId !== "local");
      assert.equal(providerReadiness(provider, "terminal", false).action, machineId === "local" ? "settings" : "signIn");
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Gemini accounts guidance is remote-only, bilingual, and limited to the bundled plugin row", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    for (const language of ["en", "zh-CN"]) for (const machineId of ["local", "office-pc"]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { threadterm: { machineId } } });
      const data = { settings: { language, revision: 1 }, projects: [], providers: [{ ...capability("gemini"), source: "plugin" }] } as unknown as Snapshot;
      const html = renderToStaticMarkup(createElement(ProviderSettingsPanel, { data }));
      const text = language === "en" ? "Google sign-in can’t run in ThreadTerm’s browser. Use an API key, or sign in on that computer." : "Google 登录无法在 ThreadTerm 浏览器中完成。请使用 API 密钥，或在那台电脑上登录。";
      assert.equal(html.includes(text), machineId !== "local");
      assert.doesNotMatch(html, /Open sign-in terminal|打开登录终端<\/button>/);
      const other = { ...data, providers: [{ ...capability("echo"), source: "plugin" as const }] };
      assert.ok(!renderToStaticMarkup(createElement(ProviderSettingsPanel, { data: other })).includes(text));
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
