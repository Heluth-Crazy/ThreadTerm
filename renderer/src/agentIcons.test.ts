import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createRequire } from "node:module";
Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import("react-dom/server");
import type { ProviderCapability } from "@threadterm/protocol";
import { AgentIcon, AgentIconsProvider, agentIconMarkup } from "./components/PrototypeIcon";

const icon = "data:image/svg+xml;base64,PHN2Zy8+";
const capability = (id: string): ProviderCapability => ({ id, name: "Echo", icon, installed: true, terminal: true, chat: true, history: false, resume: false });
const render = (id: string, providers: ProviderCapability[]) => renderToStaticMarkup(createElement(AgentIconsProvider, { providers, children: createElement(AgentIcon, { provider: id, size: 18 }) }));

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
