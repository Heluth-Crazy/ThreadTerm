// Context-usage and connection-status helpers (task 10-11-chat-parity C3).
//
// Pure, total functions over the additive `ChatContextUsage` snapshot: the ring
// tier, the popover rows (unknown/zero hidden), the cache hit rate and the
// connection chip's short label. No DOM, no timers, no provider-name branching.

import type { ChatConnectionPhase, ChatContextUsage, RuntimeEvent } from "@threadterm/protocol";
import type { ComposerCopy } from "./composerOptions";

export type ContextTier = "neutral" | "warn" | "danger";

export type ContextRowKey = "input" | "output" | "cacheRead" | "cacheWrite" | "total";

export type ContextRow = { key: ContextRowKey; value: number };

export const CONTEXT_ROW_LABELS: Record<ContextRowKey, [string, string]> = {
  input: ["Input", "输入"],
  output: ["Output", "输出"],
  cacheRead: ["Cache read", "缓存读取"],
  cacheWrite: ["Cache write", "缓存写入"],
  total: ["Total", "总计"],
};

const ROW_ORDER: ContextRowKey[] = ["input", "output", "cacheRead", "cacheWrite", "total"];

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The ring tier: neutral below 70 %, warning from 70 %, danger from 90 %. */
export function contextTier(percent: number | undefined): ContextTier {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "neutral";
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warn";
  return "neutral";
}

/** Used percentage from the provider value, or derived from used/window. */
export function contextPercent(usage: ChatContextUsage | null | undefined): number | undefined {
  if (!usage || !positive(usage.windowTokens)) return undefined;
  if (typeof usage.percent === "number" && Number.isFinite(usage.percent)) return Math.max(0, usage.percent);
  if (nonnegative(usage.usedTokens)) return (usage.usedTokens / usage.windowTokens) * 100;
  return undefined;
}

/** Nothing to show when every counter is missing or zero. */
export function hasContextUsage(usage: ChatContextUsage | null | undefined): usage is ChatContextUsage {
  if (!usage) return false;
  return [usage.usedTokens, usage.windowTokens, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.totalTokens].some(positive);
}

/** Popover rows for the known, non-zero counters, in a fixed order. */
export function contextRows(usage: ChatContextUsage): ContextRow[] {
  const sources: Record<ContextRowKey, number | undefined> = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    total: usage.totalTokens,
  };
  return ROW_ORDER.filter(key => positive(sources[key])).map(key => ({ key, value: sources[key] as number }));
}

/** cacheRead / (input + cacheRead); undefined when there are no cache reads to report. */
export function contextCacheHitRate(usage: ChatContextUsage): number | undefined {
  const read = usage.cacheReadTokens;
  if (!positive(read)) return undefined;
  if (!nonnegative(usage.inputTokens)) return undefined;
  const input = usage.inputTokens;
  return read / (input + read);
}

/** Shared token formatting: grouped digits, no locale surprises in QA. */
export function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatPercent(percent: number | undefined): string | undefined {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  return `${Math.round(percent)}%`;
}

/** Short connection label; the dot's colour is never the only signal. */
export function connectionChipLabel(phase: ChatConnectionPhase, copy: ComposerCopy): string {
  switch (phase) {
    case "ready": return copy("Connected", "已连接");
    case "connecting": return copy("Connecting", "连接中");
    case "failed": return copy("Error", "错误");
    case "unavailable": return copy("Unavailable", "不可用");
    default: return copy("Disconnected", "已断开");
  }
}

export type ConnectionTone = "ok" | "busy" | "error" | "idle" | "muted";

export function connectionTone(phase: ChatConnectionPhase, transportDown = false): ConnectionTone {
  if (transportDown) return "error";
  switch (phase) {
    case "ready": return "ok";
    case "connecting": return "busy";
    case "failed": return "error";
    case "unavailable": return "muted";
    default: return "idle";
  }
}

/** Spend the model's flexible width on the new status controls before changing
 * the C2 option-fold budget. The model keeps its existing minimum reserve. */
export function statusModelReserve(naturalReserve: number, statusWidth: number, minimum: number): number {
  return Math.max(minimum, naturalReserve - statusWidth);
}

/** Hydrate on opening/reconnecting; subsequent updates are pushed. A newer
 * event (including a clear) or transport generation always wins over a read. */
export function observeContextUsage(
  sessionId: string,
  read: () => Promise<ChatContextUsage | null>,
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void,
  update: (usage: ChatContextUsage | undefined) => void,
): () => void {
  let disposed = false;
  let revision = 0;
  const hydrate = () => {
    const started = ++revision;
    void read().then(usage => {
      if (!disposed && started === revision) update(usage ?? undefined);
    }).catch(() => undefined);
  };
  update(undefined);
  const unsubscribe = subscribe(event => {
    if (disposed || !event.data || typeof event.data !== "object") return;
    const data = event.data as { sessionId?: string; usage?: ChatContextUsage | null; state?: string };
    if (event.event === "chat.context" && data.sessionId === sessionId) {
      revision += 1;
      update(data.usage ?? undefined);
    }
    if (event.event === "runtime.transport") {
      if (data.state === "disconnected" || data.state === "incompatible") revision += 1;
      if (data.state === "reconnected") { update(undefined); hydrate(); }
    }
  });
  hydrate();
  return () => { disposed = true; revision += 1; unsubscribe(); };
}
