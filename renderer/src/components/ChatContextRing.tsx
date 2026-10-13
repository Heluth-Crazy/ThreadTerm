// Context ring + popover (task 10-11-chat-parity C3).
//
// An 18 px ring whose colour follows the used percentage, with a popover that
// lists the known token counters. It renders nothing when the session has no
// usage at all, and a neutral tokens-only ring when no window is known. No
// timers: the popover's outside-click/Escape listeners exist only while open.

import { useEffect } from "react";
import { useStatusPopover } from "./useStatusPopover";
import type { ChatContextUsage } from "@threadterm/protocol";
import type { ComposerCopy } from "../composerOptions";
import { CONTEXT_ROW_LABELS, contextCacheHitRate, contextPercent, contextRows, contextTier, formatPercent, formatTokens, hasContextUsage } from "../contextUsage";

const SIZE = 18;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const positiveNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function ChatContextRing({ usage, copy }: { usage?: ChatContextUsage | null; copy: ComposerCopy }) {
  const { open, setOpen, toggle, anchor, trigger, dialog, id } = useStatusPopover();
  useEffect(() => { if (!hasContextUsage(usage)) setOpen(false); }, [usage, setOpen]);

  if (!hasContextUsage(usage)) return null;
  const percent = contextPercent(usage);
  const percentText = formatPercent(percent);
  const tier = contextTier(percent);
  const fraction = percent === undefined ? 0 : Math.max(0, Math.min(100, percent)) / 100;
  const label = percentText ? copy(`Context used ${percentText}`, `上下文已用 ${percentText}`) : copy("Context tokens", "上下文用量");
  const rows = contextRows(usage);
  const hitRate = contextCacheHitRate(usage);
  const windowTokens = positiveNumber(usage.windowTokens) ? usage.windowTokens : undefined;
  const usedTokens = typeof usage.usedTokens === "number" && Number.isFinite(usage.usedTokens) && usage.usedTokens >= 0 ? usage.usedTokens : undefined;
  const used = usedTokens !== undefined && windowTokens !== undefined
    ? `${formatTokens(usedTokens)} / ${formatTokens(windowTokens)}`
    : undefined;

  return (
    <span className="chat-compose-anchor chat-status-anchor" ref={anchor}>
      <button
        type="button"
        ref={trigger}
        className="chip chip-btn is-plain is-icon chat-compose-chip chat-status-chip chat-context-ring"
        data-status-trigger="context"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        onClick={toggle}
      >
        <svg className="chat-context-ring-svg" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle className="chat-context-ring-track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} />
          <circle
            className={`chat-context-ring-fill is-${tier}`}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </svg>
      </button>
      {percentText ? <span className="sr-only chat-context-percent" aria-hidden="true">{percentText}</span> : <span className="sr-only chat-context-tokens" aria-hidden="true">{copy("Tokens", "用量")}</span>}
      {open && (
        <div className="chat-compose-menu chat-status-menu is-anchored" ref={dialog} id={id} tabIndex={-1} role="dialog" aria-label={copy("Context usage", "上下文用量")}>
          <p className="chat-menu-label">{copy("Context usage", "上下文用量")}</p>
          {used && (
            <div className="chat-status-row">
              <span className="chat-status-key">{copy("Used", "已用")}</span>
              <span className="chat-status-value">{used}</span>
              {percentText && <span className="chat-status-meta">{percentText}</span>}
            </div>
          )}
          {!used && windowTokens !== undefined && (
            <div className="chat-status-row">
              <span className="chat-status-key">{copy("Max", "上限")}</span>
              <span className="chat-status-value">{formatTokens(windowTokens)}</span>
            </div>
          )}
          {windowTokens === undefined && usedTokens !== undefined && usedTokens > 0 && (
            <div className="chat-status-row">
              <span className="chat-status-key">{copy("Used tokens", "已用令牌")}</span>
              <span className="chat-status-value">{formatTokens(usedTokens)}</span>
            </div>
          )}
          {rows.map(row => (
            <div className="chat-status-row" key={row.key}>
              <span className="chat-status-key">{copy(CONTEXT_ROW_LABELS[row.key][0], CONTEXT_ROW_LABELS[row.key][1])}</span>
              <span className="chat-status-value">{formatTokens(row.value)}</span>
            </div>
          ))}
          {hitRate !== undefined && (
            <div className="chat-status-row">
              <span className="chat-status-key">{copy("Cache hit rate", "缓存命中率")}</span>
              <span className="chat-status-value">{Math.round(hitRate * 100)}%</span>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
