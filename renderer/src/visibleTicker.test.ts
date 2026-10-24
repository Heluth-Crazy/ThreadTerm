import assert from "node:assert/strict";
import test from "node:test";
import { startVisibleTicker, type TickerDocument, type TickerTimers } from "./visibleTicker";

function harness(visibilityState = "visible") {
  const intervals: { handler: () => void; ms: number; cleared: boolean }[] = [];
  const listeners = new Set<() => void>();
  const doc: TickerDocument = {
    visibilityState,
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
  };
  const timers: TickerTimers = {
    setInterval: (handler, ms) => { intervals.push({ handler, ms, cleared: false }); return intervals.length; },
    clearInterval: id => { const entry = intervals[id - 1]; if (entry) entry.cleared = true; },
  };
  return {
    doc, timers, intervals, listeners,
    show(state: string) { doc.visibilityState = state; for (const listener of [...listeners]) listener(); },
    live() { return intervals.filter(entry => !entry.cleared); },
  };
}

test("an inactive clock keeps no timer while the document stays visible", () => {
  const probe = harness();
  let ticks = 0;
  const stop = startVisibleTicker({ tick: () => { ticks += 1; }, active: false, document: probe.doc, timers: probe.timers });
  assert.equal(probe.intervals.length, 0);
  assert.equal(probe.listeners.size, 0);
  stop();
  assert.equal(ticks, 0);
});

test("a hidden document keeps no timer and starts one only when it becomes visible", () => {
  const probe = harness("hidden");
  let ticks = 0;
  const stop = startVisibleTicker({ tick: () => { ticks += 1; }, active: true, document: probe.doc, timers: probe.timers });
  assert.equal(probe.intervals.length, 0);
  probe.show("visible");
  assert.equal(probe.live().length, 1);
  assert.equal(probe.live()[0].ms, 1000);
  assert.equal(ticks, 1, "returning to a visible window refreshes the clock immediately");
  probe.show("hidden");
  assert.equal(probe.live().length, 0, "hiding the window stops the timer");
  probe.show("visible");
  assert.equal(probe.live().length, 1);
  stop();
  assert.equal(probe.live().length, 0);
  assert.equal(probe.listeners.size, 0);
});

test("a clock stops itself once its deadline passes instead of polling forever", () => {
  const probe = harness();
  let ticks = 0, expired = false;
  const stop = startVisibleTicker({ tick: () => { ticks += 1; }, active: true, stopWhen: () => expired, document: probe.doc, timers: probe.timers });
  assert.equal(probe.live().length, 1);
  probe.live()[0].handler();
  assert.equal(probe.live().length, 1);
  expired = true;
  probe.live()[0].handler();
  assert.equal(ticks, 2);
  assert.equal(probe.live().length, 0, "the last tick clears the interval");
  stop();
});
