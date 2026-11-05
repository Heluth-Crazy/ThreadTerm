import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { LocalFileAccessSettings } from "./LocalFileAccessSettings";

function withBridge(bridge: unknown, action: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { threadterm: bridge } });
    action();
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("local file backend setting is local-only and exposes bilingual pending choices", () => {
  const localFiles = { getBackend: async () => "runtime" as const, setBackend: async (mode: "runtime" | "main") => mode };
  withBridge({ machineId: "local", localFiles }, () => {
    const html = renderToStaticMarkup(createElement(LocalFileAccessSettings, { zh: false }));
    assert.match(html, /Local file access/);
    assert.match(html, /Background process/);
    assert.match(html, /Main process/);
    assert.match(html, /Remote files always follow their host computer/);
    assert.match(html, /fieldset disabled/);
  });
  withBridge({ machineId: "remote", localFiles }, () => {
    assert.equal(renderToStaticMarkup(createElement(LocalFileAccessSettings, { zh: false })), "");
  });
  withBridge({ machineId: "local", localFiles }, () => {
    const html = renderToStaticMarkup(createElement(LocalFileAccessSettings, { zh: true }));
    assert.match(html, /本地文件访问/);
    assert.match(html, /后台进程/);
    assert.match(html, /主进程/);
  });
});
