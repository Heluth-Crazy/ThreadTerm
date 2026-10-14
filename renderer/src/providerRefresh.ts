// Manual provider-refresh tracking (task 10-14 P1).
//
// The runtime answers `provider.refresh` with a refresh id and publishes the
// round's completion later as `state.changed {kind:"providers", refreshId?,
// outcome}`. This module owns the small state machine and the pure helpers, so
// the component stays about rendering and the behavior can be unit-tested
// without a DOM. It never calls `provider.list`, which is a cached read.

import type { RuntimeEvent } from "@threadterm/protocol";

/** How long a manual round may stay unchecked before the UI says it is still running. */
export const PROVIDER_REFRESH_TIMEOUT_MS = 120_000;

export type ProviderRefreshPhase = "idle" | "checking" | "updated" | "failed" | "timeout";

export type ProviderRefreshOutcome = "ok" | "failed";

export interface ProviderRefreshState {
  phase: ProviderRefreshPhase;
  /** The generation of the tracked round; stays set after a timeout so a late event still lands. */
  refreshId?: number;
}

export const IDLE_PROVIDER_REFRESH: ProviderRefreshState = { phase: "idle" };

/** The provider fields of a `state.changed` event; undefined for every other event. */
export function providerRefreshEvent(data: unknown): { refreshId?: number; outcome?: ProviderRefreshOutcome } | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.kind !== "providers") return undefined;
  const refreshId = typeof record.refreshId === "number" && Number.isSafeInteger(record.refreshId) && record.refreshId >= 0
    ? record.refreshId
    : undefined;
  const outcome = record.outcome === "ok" || record.outcome === "failed" ? record.outcome : undefined;
  return { refreshId, outcome };
}

/** True when an event completes the round started for `expected`. */
export function providerRefreshCompletes(expected: number, incoming: number | undefined): boolean {
  return incoming !== undefined && Number.isSafeInteger(incoming) && incoming >= expected;
}

export interface ProviderRefreshHandle {
  /** Sends the forced refresh and tracks its round. Resolves when the request settles, not the probe. */
  refresh(): Promise<void>;
  /** Stops tracking and unsubscribes. Idempotent. */
  dispose(): void;
}

export interface ProviderRefreshOptions {
  timeoutMs?: number;
  /** Injected in tests; defaults to the window timers. */
  setTimer?: (handler: () => void, timeout: number) => number;
  clearTimer?: (handle: number) => void;
  /** Called once, when a tracked round reaches a terminal outcome. */
  onOutcome?: (outcome: ProviderRefreshOutcome) => void;
}

/**
 * Tracks one manual provider refresh at a time. A newer refresh supersedes an
 * older one; only a providers event whose `refreshId` is at least the tracked
 * one ends the round, so an unrelated snapshot cannot clear the checking state.
 * Events and completions after `dispose()` (unmount) are ignored.
 */
export function observeProviderRefresh(
  send: () => Promise<{ refreshId: number }>,
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void,
  update: (state: ProviderRefreshState) => void,
  options: ProviderRefreshOptions = {},
): ProviderRefreshHandle {
  const timeoutMs = options.timeoutMs ?? PROVIDER_REFRESH_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((handler, timeout) => setTimeout(handler, timeout) as unknown as number);
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle));
  let disposed = false;
  let state: ProviderRefreshState = IDLE_PROVIDER_REFRESH;
  let timer: number | undefined;

  const clearTimerHandle = () => {
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
  };
  const publish = (next: ProviderRefreshState) => {
    state = next;
    if (!disposed) update(state);
  };
  const active = () => !disposed && state.refreshId !== undefined && (state.phase === "checking" || state.phase === "timeout");

  const unsubscribe = subscribe(event => {
    if (!active() || event.event !== "state.changed") return;
    const parsed = providerRefreshEvent(event.data);
    if (!parsed || !providerRefreshCompletes(state.refreshId as number, parsed.refreshId)) return;
    clearTimerHandle();
    const outcome = parsed.outcome ?? "ok";
    publish({ phase: outcome === "failed" ? "failed" : "updated", refreshId: state.refreshId });
    options.onOutcome?.(outcome);
  });

  return {
    async refresh() {
      try {
        const { refreshId } = await send();
        if (disposed || !Number.isSafeInteger(refreshId)) return;
        clearTimerHandle();
        publish({ phase: "checking", refreshId });
        timer = setTimer(() => {
          if (!disposed && state.refreshId === refreshId && state.phase === "checking") {
            publish({ phase: "timeout", refreshId });
          }
        }, timeoutMs);
      } catch (error) {
        if (!disposed) throw error;
      }
    },
    dispose() {
      disposed = true;
      clearTimerHandle();
      unsubscribe();
    },
  };
}

/** User-visible copy for the manual refresh states, in both supported locales. */
export const PROVIDER_REFRESH_TEXT = {
  en: {
    refresh: "Refresh provider status",
    checking: "Checking providers…",
    updated: "Provider status updated.",
    failed: "Provider status could not be refreshed. Showing the last known status.",
    timeout: "Still checking providers… The status updates when the check finishes.",
    detectionFailed: "Provider detection failed. Use Refresh provider status to try again.",
  },
  zh: {
    refresh: "刷新提供商状态",
    checking: "正在检测提供商…",
    updated: "提供商状态已更新。",
    failed: "无法刷新提供商状态，正在显示上次检测结果。",
    timeout: "仍在检测提供商……检测完成后状态会自动更新。",
    detectionFailed: "提供商检测失败。请使用“刷新提供商状态”重试。",
  },
} as const;

export interface ProviderRefreshText {
  refresh: string;
  checking: string;
  updated: string;
  failed: string;
  timeout: string;
  detectionFailed: string;
}

export function providerRefreshText(locale: string): ProviderRefreshText {
  return locale === "zh-CN" ? PROVIDER_REFRESH_TEXT.zh : PROVIDER_REFRESH_TEXT.en;
}
