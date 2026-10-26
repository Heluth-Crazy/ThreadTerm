import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Locale } from "../i18n";
import "./runtime-status.css";

export type RuntimeStatusState = "connecting" | "connected" | "reconnecting" | "unavailable";
type ProblemState = Extract<RuntimeStatusState, "reconnecting" | "unavailable">;

const copy = (locale: Locale, en: string, zh: string) => locale === "zh-CN" ? zh : en;
const stateText = (locale: Locale, state: RuntimeStatusState) => {
  if (state === "connected") return copy(locale, "Runtime connected", "运行时已连接");
  if (state === "connecting") return copy(locale, "Connecting…", "正在连接…");
  if (state === "reconnecting") return copy(locale, "Reconnecting to runtime…", "正在重新连接运行时…");
  return copy(locale, "Runtime unavailable", "运行时不可用");
};

/** Problem chrome is intentionally delayed so startup and short reconnects stay silent. */
export function useVisibleRuntimeProblem(state: RuntimeStatusState): ProblemState | undefined {
  const [visible, setVisible] = useState<ProblemState>();
  useEffect(() => {
    if (state !== "reconnecting" && state !== "unavailable") {
      setVisible(undefined);
      return;
    }
    const timer = window.setTimeout(() => setVisible(state), 1_000);
    return () => window.clearTimeout(timer);
  }, [state]);
  return visible;
}

export function RuntimeAvatarBadge({ state, locale }: { state?: ProblemState; locale: Locale }) {
  if (!state) return null;
  return <span data-runtime-badge data-state={state} title={stateText(locale, state)} aria-label={stateText(locale, state)} />;
}

export function RuntimeStatusChip({ state, locale, onRetry, placementKey }: { state?: ProblemState; locale: Locale; onRetry: () => void; placementKey: string }) {
  const [host, setHost] = useState<HTMLElement>();
  useLayoutEffect(() => {
    if (!state) { setHost(undefined); return; }
    const content = document.querySelector<HTMLElement>(".content.main");
    const next = content?.querySelector<HTMLElement>(".runtime-workspace .ws-top, .project-file-page .ws-top, .page-head .page-actions, .ov-page-head .page-actions, .usage-page .usage-head")
      ?? content?.querySelector<HTMLElement>(".runtime-workspace .ws-top, .project-file-page .ws-top, .page-head, .ov-page-head, .usage-page .usage-head")
      ?? content?.querySelector<HTMLElement>("[data-runtime-header-host]");
    setHost(next ?? undefined);
  }, [state, placementKey]);
  if (!state) return null;
  const chip = <div data-runtime-chip data-state={state} role="status" aria-live="polite"><span className="runtime-status-dot" aria-hidden="true" /><span>{stateText(locale, state)}</span>{state === "unavailable" && <button type="button" onClick={onRetry}>{copy(locale, "Retry", "重试")}</button>}</div>;
  return host ? createPortal(chip, host) : null;
}

export function RuntimeStatusMenuRow({ state, locale }: { state: RuntimeStatusState; locale: Locale }) {
  const label = state === "reconnecting" ? copy(locale, "Reconnecting…", "正在重新连接…") : stateText(locale, state);
  return <section data-runtime-status data-state={state} role="status" aria-live="polite"><span className="runtime-status-line"><span className="runtime-status-dot" aria-hidden="true" /><strong>{label}</strong></span><small>{copy(locale, "Local runtime · this computer", "本地运行 · 本机")}</small></section>;
}
