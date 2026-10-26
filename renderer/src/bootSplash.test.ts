import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("settled splash exits once when an occluded window pauses animation frames", async () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let removed = 0, disconnected = 0, cancelled = 0, scheduled = 0;
  let tick: FrameRequestCallback | undefined;
  let fallback: (() => void) | undefined;
  let delay = 0;
  const node = () => ({ style: {}, classList: { add() {} }, append() {}, lastElementChild: { style: {} }, getContext: () => null });
  const parts = new Map<string, ReturnType<typeof node>>();
  const root = {
    lang: "en", dataset: {}, style: {}, clientWidth: 1000, clientHeight: 800,
    querySelector: (selector: string) => {
      if (!parts.has(selector)) parts.set(selector, node());
      return parts.get(selector);
    },
    remove: () => { removed += 1; },
  };
  install("document", { getElementById: () => root, createElement: node });
  install("matchMedia", () => ({ matches: false }));
  install("getComputedStyle", () => ({ color: "black" }));
  install("devicePixelRatio", 1);
  install("ResizeObserver", class { observe() {} disconnect() { disconnected += 1; } });
  install("requestAnimationFrame", (callback: FrameRequestCallback) => { tick = callback; return 1; });
  install("cancelAnimationFrame", () => { cancelled += 1; });
  install("setTimeout", (callback: () => void, milliseconds: number) => { scheduled += 1; fallback = callback; delay = milliseconds; return 1; });
  install("clearTimeout", () => { fallback = undefined; });
  try {
    const { settleBootSplash } = await import("./bootSplash");
    assert.equal(scheduled, 0, "no timer before the app settles");
    settleBootSplash("ready");
    assert.equal(scheduled, 1);
    assert.ok(delay >= 620 && delay <= 3240, "remaining animation plus exit and margin is bounded");
    settleBootSplash("failed");
    assert.equal(scheduled, 1, "first outcome wins without rearming");
    assert.equal(removed, 0);
    const expire = fallback!;
    expire();
    assert.equal(removed, 1);
    assert.equal(disconnected, 1);
    assert.equal(cancelled, 1);
    assert.equal(fallback, undefined);
    expire();
    settleBootSplash("ready");
    assert.equal(removed, 1, "late callbacks cannot finish twice");
    assert.equal(scheduled, 1);
    assert.ok(tick);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("splash first paint follows the stored family palette after an OS appearance change", async () => {
  const { rememberBootAppearance } = await import("./bootSplash");
  const originalStorage = globalThis.localStorage;
  let saved = "";
  Object.assign(globalThis, { localStorage: { setItem: (_key: string, value: string) => { saved = value; } } });
  const light = { background: "#fdf6e3", surface: "#fdf6e3", text: "#586e75", muted: "#657b83", border: "#eee8d5" };
  const dark = { background: "#002b36", surface: "#073642", text: "#93a1a1", muted: "#839496", border: "#586e75" };
  try {
    rememberBootAppearance({ theme: "system", locale: "zh-CN", tokens: light, lightTokens: light, darkTokens: dark });
    const script = readFileSync("renderer/index.html", "utf8").match(/<script>([\s\S]*?)<\/script>/)![1];
    for (const systemDark of [false, true]) {
      const values = new Map<string, string>();
      const splash = { dataset: {}, lang: "", style: { setProperty: (key: string, value: string) => values.set(key, value) } };
      runInNewContext(script, { document: { getElementById: () => splash }, URLSearchParams, location: { search: "" }, localStorage: { getItem: () => saved }, matchMedia: (query: string) => ({ matches: query.includes("color-scheme") && systemDark }) });
      assert.equal(values.get("--splash-bg"), (systemDark ? dark : light).background);
      assert.equal(splash.lang, "zh-CN");
    }
  } finally { Object.assign(globalThis, { localStorage: originalStorage }); }
});
