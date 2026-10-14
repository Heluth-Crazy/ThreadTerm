// Manual provider-refresh tracking (task 10-14 P1).
//
// The runtime answers `provider.refresh` with a refresh id and publishes each
// capability round's completion later as `state.changed {kind:"providers",
// generation, outcome}`. This module owns the small state machine and the pure
// helpers, so the component stays about rendering and the behavior can be
// unit-tested without a DOM. It never calls `provider.list`, which is a cached
// read. RPC replies and events have separate delivery paths, so a completion
// can arrive before the reply; those are buffered until the refresh id is known.

import type { RuntimeEvent } from "@threadterm/protocol";

/** How long a manual round may stay unchecked before the UI says it is still running. */
export const PROVIDER_REFRESH_TIMEOUT_MS = 120_000;

export type ProviderRefreshPhase = "idle" | "checking" | "updated" | "failed" | "timeout";

export type ProviderRefreshOutcome = "ok" | "failed";

export interface ProviderRefreshState {
  phase: ProviderRefreshPhase;
  /** The generation claimed by the tracked round; stays set after a timeout so a late event still lands. */
  refreshId?: number;
}

export const IDLE_PROVIDER_REFRESH: ProviderRefreshState = { phase: "idle" };

/** The provider fields of a `state.changed` event; undefined for every other event. */
export function providerRefreshEvent(data: unknown): { generation?: number; outcome?: ProviderRefreshOutcome } | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.kind !== "providers") return undefined;
  const generation = typeof record.generation === "number" && Number.isSafeInteger(record.generation) && record.generation >= 0
    ? record.generation
    : undefined;
  const outcome = record.outcome === "ok" || record.outcome === "failed" ? record.outcome : undefined;
  return { generation, outcome };
}

/** True when a completion belongs to the tracked round or a newer (superseding) one. */
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
 * Tracks one manual provider refresh at a time. It subscribes before the first
 * request, buffers completions that arrive before the reply, and then finishes
 * on the first buffered or later providers completion whose `generation` is at
 * least the returned refresh id, so a newer round (another refresh or a plugin
 * reload) supersedes and also finishes the check. An unrelated snapshot or an
 * older generation never ends it. Events and completions after `dispose()`
 * (unmount) are ignored.
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
  let phase: ProviderRefreshPhase = "idle";
  let refreshId: number | undefined;
  let inFlight = false;
  let buffered: { generation?: number; outcome: ProviderRefreshOutcome } | undefined;
  let timer: number | undefined;

  const clearTimerHandle = () => {
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
  };
  // A function call defeats TypeScript's narrowing of `buffered` to undefined
  // in this scope: it is assigned from the event subscriber callback.
  const peekBuffered = () => buffered;
  const publish = () => {
    if (disposed) return;
    update(refreshId === undefined ? { phase } : { phase, refreshId });
  };
  const armTimeout = () => {
    clearTimerHandle();
    timer = setTimer(() => {
      if (!disposed && phase === "checking") { phase = "timeout"; publish(); }
    }, timeoutMs);
  };
  const complete = (outcome: ProviderRefreshOutcome) => {
    clearTimerHandle();
    phase = outcome === "failed" ? "failed" : "updated";
    publish();
    options.onOutcome?.(outcome);
  };

  const unsubscribe = subscribe(event => {
    if (disposed || event.event !== "state.changed") return;
    const parsed = providerRefreshEvent(event.data);
    if (!parsed) return;
    // The reply may still be on its way; keep the newest completion until the id is known.
    if (inFlight) { buffered = { generation: parsed.generation, outcome: parsed.outcome ?? "ok" }; return; }
    if (phase !== "checking" && phase !== "timeout") return;
    if (refreshId === undefined || !providerRefreshCompletes(refreshId, parsed.generation)) return;
    complete(parsed.outcome ?? "ok");
  });

  return {
    async refresh() {
      if (disposed) return;
      inFlight = true;
      buffered = undefined;
      phase = "checking";
      refreshId = undefined;
      publish();
      armTimeout();
      let id: number;
      try {
        ({ refreshId: id } = await send());
      } catch (error) {
        inFlight = false;
        clearTimerHandle();
        phase = "idle";
        publish();
        if (!disposed) throw error;
        return;
      }
      if (disposed) return;
      inFlight = false;
      if (!Number.isSafeInteger(id)) {
        clearTimerHandle();
        phase = "idle";
        publish();
        return;
      }
      refreshId = id;
      publish();
      const early = peekBuffered();
      if (early && providerRefreshCompletes(id, early.generation)) {
        complete(early.outcome);
      }
    },
    dispose() {
      disposed = true;
      inFlight = false;
      buffered = undefined;
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
