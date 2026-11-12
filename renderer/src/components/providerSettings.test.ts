import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderCapability } from "@threadterm/protocol";
import { accountProviders, signInTerminal } from "./providerSettings";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import AgentsSettings, { agentRow, installRunKey, runCommand, runSettled } from "./AgentsSettings";
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

test("Gemini sign-in guidance is remote-only, bilingual, and limited to the bundled plugin row", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    for (const zh of [false, true]) for (const machineId of ["local", "office-pc"]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { threadterm: { machineId } } });
      const data = { settings: { language: zh ? "zh-CN" : "en", revision: 1 }, projects: [], providers: [{ ...capability("gemini"), source: "plugin" }] } as unknown as Snapshot;
      const render = (snapshot: Snapshot) => renderToStaticMarkup(createElement(AgentsSettings, { data: snapshot, zh, onSignInSession() {} }));
      const html = render(data);
      const text = zh ? "Google 登录无法在 ThreadTerm 浏览器中完成。请使用 API 密钥，或在那台电脑上登录。" : "Google sign-in can’t run in ThreadTerm’s browser. Use an API key, or sign in on that computer.";
      assert.equal(html.includes(text), machineId !== "local");
      const other = { ...data, providers: [{ ...capability("echo"), source: "plugin" as const }] };
      assert.ok(!render(other).includes(text));
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("an agent row shows one primary action: sign in when signed out, install help when missing, none when fine", () => {
  const signed = { ...capability("codex"), installed: true, auth: "authenticated" as const, signIn: { executable: "codex", args: ["login"], display: "codex login" } };
  assert.deepEqual(agentRow(signed, { remote: false }), { state: "signed-in" });
  assert.deepEqual(agentRow({ ...signed, auth: "unauthenticated" }, { remote: false }), { state: "signed-out", primary: "signIn" });
  assert.deepEqual(agentRow({ ...signed, auth: undefined }, { remote: false }), { state: "unknown" });
  assert.deepEqual(agentRow({ ...signed, installed: false, homepage: "https://example.test" }, { remote: false }), { state: "missing", primary: "homepage" });
  assert.deepEqual(agentRow({ ...signed, installed: false, homepage: undefined }, { remote: false }), { state: "missing" });
});

test("a signed-out row offers sign-in only when the command exists for that machine", () => {
  const command = { executable: "grok", args: ["login"], display: "grok login" };
  const remoteCommand = { executable: "grok", args: ["login", "--device-auth"], display: "grok login --device-auth" };
  const signedOut = { ...capability("grok"), auth: "unauthenticated" as const };
  assert.deepEqual(agentRow(signedOut, { remote: false }), { state: "signed-out", primary: undefined });
  assert.deepEqual(agentRow({ ...signedOut, signIn: command }, { remote: false }), { state: "signed-out", primary: "signIn" });
  assert.deepEqual(agentRow({ ...signedOut, remoteSignIn: remoteCommand }, { remote: false }), { state: "signed-out", primary: undefined });
  assert.deepEqual(agentRow({ ...signedOut, remoteSignIn: remoteCommand }, { remote: true }), { state: "signed-out", primary: "signIn" });
  assert.deepEqual(agentRow({ ...signedOut, signIn: command }, { remote: true }), { state: "signed-out", primary: "signIn" });
  assert.deepEqual(agentRow({ ...signedOut, signIn: command, installed: false }, { remote: true }), { state: "missing" });
});

test("an install row offers one action: install, Node.js first, or install help", () => {
  const install = { executable: "C:/npm.cmd", args: ["install", "-g", "@openai/codex"], display: "npm install -g @openai/codex", cwd: "C:/Users/qa" };
  const node = { executable: "C:/winget.exe", args: ["install", "--id", "OpenJS.NodeJS.LTS"], display: "winget install --id OpenJS.NodeJS.LTS", cwd: "C:/Users/qa" };
  const missing = { ...capability("codex", false), install, homepage: "https://github.com/openai/codex" };
  assert.deepEqual(agentRow(missing, { remote: false }), { state: "missing", primary: "install" });
  // Node.js is missing: the row asks for it before the agent, and only when the command is known.
  assert.deepEqual(agentRow({ ...missing, install: undefined, installBlocked: "node_missing", nodeInstall: node }, { remote: false }), { state: "node-missing", primary: "node" });
  assert.deepEqual(agentRow({ ...missing, install: undefined, installBlocked: "node_missing", nodeInstall: undefined }, { remote: false }), { state: "missing", primary: "homepage" });
  // No recipe at all: the homepage is the only action.
  assert.deepEqual(agentRow({ ...missing, install: undefined }, { remote: false }), { state: "missing", primary: "homepage" });
  assert.deepEqual(agentRow({ ...missing, install: undefined, homepage: undefined }, { remote: false }), { state: "missing" });
});

test("a run in flight, a failed run and a finished run drive the same row", () => {
  const install = { executable: "C:/npm.cmd", args: ["install", "-g", "@openai/codex"], display: "npm install -g @openai/codex" };
  const node = { executable: "C:/winget.exe", args: ["install"], display: "winget install --id OpenJS.NodeJS.LTS" };
  const missing = { ...capability("codex", false), install, nodeInstall: node };
  const running = { state: "installing" } as const;
  assert.deepEqual(agentRow(missing, { remote: false, run: { kind: "install", sessionId: "s1" } }), running);
  // Exit 0 keeps the row in progress until the refreshed capability arrives (the row then says 登录 or 已登录).
  assert.deepEqual(agentRow(missing, { remote: false, run: { kind: "install", sessionId: "s1", exitCode: 0 } }), running);
  assert.deepEqual(agentRow({ ...missing, installed: true, auth: "unauthenticated", signIn: { executable: "codex", args: ["login"], display: "codex login" } }, { remote: false, run: { kind: "install", sessionId: "s1", exitCode: 0 } }), running);
  // A failure keeps the row and offers the same command again; Node.js first when that is what failed.
  assert.deepEqual(agentRow(missing, { remote: false, run: { kind: "install", sessionId: "s1", exitCode: 1 } }), { state: "install-failed", primary: "install" });
  assert.deepEqual(agentRow({ ...missing, install: undefined }, { remote: false, run: { kind: "node", sessionId: "s2", exitCode: 3 } }), { state: "install-failed", primary: "node" });
  // An update never changes whether the agent is usable: a failed update keeps the row's own state (its failure
  // line is drawn below the row), and so does a row without a run.
  const installed = { ...capability("codex"), auth: "unauthenticated" as const, signIn: { executable: "codex", args: ["login"], display: "codex login" }, update: install };
  assert.deepEqual(agentRow(installed, { remote: false }), { state: "signed-out", primary: "signIn" });
  assert.deepEqual(agentRow(installed, { remote: false, run: { kind: "update", sessionId: "s3", exitCode: 2 } }), { state: "signed-out", primary: "signIn" });
  assert.deepEqual(agentRow({ ...installed, auth: "authenticated" }, { remote: false, run: { kind: "update", sessionId: "s3", exitCode: 2 } }), { state: "signed-in" });
  assert.deepEqual(agentRow(installed, { remote: false, run: { kind: "update", sessionId: "s3" } }), running);
  // Retry re-runs the same kind of command, only while the capability still offers it.
  assert.equal(runCommand(installed, "update"), install);
  assert.equal(runCommand(missing, "node"), node);
  assert.equal(runCommand({ ...missing, install: undefined }, "install"), undefined);
});

test("a finished run is dropped once the capability shows its goal, never while it runs", () => {
  const install = { executable: "C:/npm.cmd", args: ["install", "-g", "@openai/codex"], display: "npm install -g @openai/codex" };
  const node = { executable: "C:/winget.exe", args: ["install"], display: "winget install --id OpenJS.NodeJS.LTS" };
  const missing = { ...capability("codex", false), install };
  const installed = { ...capability("codex"), update: install };
  const blocked = { ...missing, install: undefined, installBlocked: "node_missing" as const, nodeInstall: node };
  // In flight: never settled, whatever the capability says (an update's agent is installed all along).
  assert.equal(runSettled(installed, { kind: "update", sessionId: "u" }), false);
  assert.equal(runSettled(installed, { kind: "install", sessionId: "i" }), false);
  // Install: settled once the agent is installed, also after a failure fixed some other way.
  assert.equal(runSettled(missing, { kind: "install", sessionId: "i", exitCode: 0 }), false);
  assert.equal(runSettled(installed, { kind: "install", sessionId: "i", exitCode: 0 }), true);
  assert.equal(runSettled(missing, { kind: "install", sessionId: "i", exitCode: 1 }), false);
  assert.equal(runSettled(installed, { kind: "install", sessionId: "i", exitCode: 1 }), true);
  // Node.js: settled once npm is found (the row then offers 安装), not while the capability still says it is missing.
  assert.equal(runSettled(blocked, { kind: "node", sessionId: "n", exitCode: 0 }), false);
  assert.equal(runSettled(missing, { kind: "node", sessionId: "n", exitCode: 0 }), true);
  assert.equal(runSettled(blocked, { kind: "node", sessionId: "n", exitCode: 5 }), false);
  // Update: exit 0 settles; a failed update stays until Retry or Dismiss, because nothing in the capability shows it.
  assert.equal(runSettled(installed, { kind: "update", sessionId: "u", exitCode: 0 }), true);
  assert.equal(runSettled(installed, { kind: "update", sessionId: "u", exitCode: 1 }), false);
  assert.equal(runSettled(undefined, { kind: "install", sessionId: "i", exitCode: 0 }), false);
});

test("a sign-in terminal uses the runtime's folder instead of a project path", () => {
  const signIn = { executable: "codex", args: ["login"], display: "codex login", cwd: "C:/Users/qa" };
  assert.equal(signInTerminal({ ...capability("codex"), signIn }, false)?.cwd, "C:/Users/qa");
  // An older runtime sends no cwd; the caller then falls back to a project folder or the picker.
  assert.equal(signInTerminal({ ...capability("codex"), signIn: { executable: "codex", args: ["login"], display: "codex login" } }, false)?.cwd, undefined);
});

test("install progress is remembered per computer and agent", async () => {
  const store = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { threadterm: { machineId: "office-pc" } } });
    assert.equal(installRunKey("codex"), "threadterm.agents.install.office-pc.codex");
    assert.equal(installRunKey("codex", "local"), "threadterm.agents.install.local.codex");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage");
    Reflect.deleteProperty(globalThis, "window");
  }
});
