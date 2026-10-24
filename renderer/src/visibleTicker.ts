import { useEffect, useRef } from "react";

export type TickerDocument = {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};
export type TickerTimers = {
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
};

/**
 * A per-second ticker that exists only while `active` and the document is visible.
 * `stopWhen` ends it from inside a tick, so a countdown stops at its deadline
 * instead of waking up forever. Returns its own cleanup.
 */
export function startVisibleTicker({ tick, active, stopWhen = () => false, intervalMs = 1000, document: doc, timers }: {
  tick: () => void;
  active: boolean;
  stopWhen?: () => boolean;
  intervalMs?: number;
  document?: TickerDocument;
  timers?: TickerTimers;
}): () => void {
  const host = doc ?? (typeof document === "undefined" ? undefined : document);
  const clock = timers ?? (typeof window === "undefined" ? undefined : window);
  if (!active || !host || !clock) return () => {};
  let timer = 0;
  const stop = () => { if (timer) { clock.clearInterval(timer); timer = 0; } };
  const run = () => { tick(); if (stopWhen()) stop(); };
  const start = () => { if (!timer) timer = clock.setInterval(run, intervalMs); };
  const onVisibility = () => { if (host.visibilityState === "hidden") stop(); else { tick(); start(); } };
  if (host.visibilityState !== "hidden") start();
  host.addEventListener("visibilitychange", onVisibility);
  return () => { stop(); host.removeEventListener("visibilitychange", onVisibility); };
}

/** React binding for `startVisibleTicker`; the effect restarts only when `active` changes. */
export function useVisibleTicker(tick: () => void, active: boolean, stopWhen?: () => boolean) {
  const latest = useRef(tick), until = useRef(stopWhen);
  latest.current = tick; until.current = stopWhen;
  useEffect(() => startVisibleTicker({ tick: () => latest.current(), active, stopWhen: () => until.current?.() === true }), [active]);
}
