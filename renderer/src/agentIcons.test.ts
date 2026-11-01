import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createRequire } from "node:module";
Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import("react-dom/server");
import type { ProviderCapability } from "@threadterm/protocol";
import { AgentIcon, AgentIconsProvider, AgentTile, agentIconMarkup, sessionIconProvider } from "./components/PrototypeIcon";
import type { Session } from "@threadterm/protocol";

const icon = "data:image/svg+xml;base64,PHN2Zy8+";
const capability = (id: string): ProviderCapability => ({ id, name: "Echo", icon, installed: true, terminal: true, chat: true, history: false, resume: false });
const render = (id: string, providers: ProviderCapability[]) => renderToStaticMarkup(createElement(AgentIconsProvider, { providers, children: createElement(AgentIcon, { provider: id, size: 18 }) }));
const renderTile = (id: string, providers: ProviderCapability[] = []) => renderToStaticMarkup(createElement(AgentIconsProvider, { providers, children: createElement(AgentTile, { provider: id, size: 16 }) }));
const session = (provider: string, terminalAgent?: string): Pick<Session, "provider" | "terminalAgent"> => ({ provider, terminalAgent });

test("plugin icons use an image with the capability data URL and decorative alt", () => {
  const html = render("echo", [capability("echo")]);
  assert.match(html, /<img class="brand-ico"/);
  assert.ok(html.includes(`src="${icon}"`));
  assert.match(html, /alt=""/);
  assert.match(html, /width:18px;height:18px/);
  assert.ok(!html.includes("<svg"));
});

test("built-in brand markup wins over capability icons; absent icons use the terminal glyph", () => {
  assert.match(render("claude", [capability("claude")]), /<svg class="brand-ico"/);
  assert.ok(!render("claude", [capability("claude")]).includes("<img"));
  assert.match(render("echo", []), /<svg class="ico brand-ico"/);
});

test("plugin ids matching Object properties still render a plugin image", () => {
  assert.match(render("constructor", [capability("constructor")]), /<img class="brand-ico"/);
  assert.equal(agentIconMarkup("constructor"), undefined);
});

test("sessionIconProvider prefers terminalAgent over the session provider", () => {
  assert.equal(sessionIconProvider(session("shell", "claude")), "claude");
  assert.equal(sessionIconProvider(session("shell")), "shell");
  assert.equal(sessionIconProvider(session("codex")), "codex");
});

test("AgentTile maps every built-in provider and falls back to a neutral shell tile", () => {
  for (const id of ["claude", "codex", "gemini", "kimi", "grok", "opencode", "pi", "shell", "custom"]) {
    const html = renderTile(id);
    assert.match(html, /class="[^"]*agent-tile/);
    assert.match(html, new RegExp(`data-agent-tile="${id === "custom" ? "custom" : id}"`));
  }
  assert.match(renderTile("claude"), /agent-tile-claude/);
  assert.match(renderTile("codex"), /agent-tile-codex/);
  assert.match(renderTile("shell"), /agent-tile-shell/);
  // Pi has its own mark (pi.dev logo), in the tile and as a flat icon, not the terminal glyph.
  assert.match(renderTile("pi"), /agent-tile-pi/);
  assert.match(renderTile("pi"), /#F09082/);
  assert.match(agentIconMarkup("pi") ?? "", /#F09082/);
  assert.match(renderTile("echo", [capability("echo")]), /<img /);
  assert.match(renderTile("unknown-plugin"), /agent-tile-shell/);
});
