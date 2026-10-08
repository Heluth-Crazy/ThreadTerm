import assert from "node:assert/strict";
import { test } from "node:test";

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
