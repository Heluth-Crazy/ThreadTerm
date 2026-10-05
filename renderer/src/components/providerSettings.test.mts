import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderCapability } from "@threadterm/protocol";
import { accountProviders, signInTerminal } from "./providerSettings.js";

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
