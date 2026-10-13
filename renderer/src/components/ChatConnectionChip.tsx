// Connection chip + popover (task 10-11-chat-parity C3).
//
// A status dot plus a short label, driven by `ChatConnectionState.phase`, with
// a popover that shows the working directory, the provider session id, the
// provider and version, and a Reconnect action. A generic `children` slot sits
// under the session facts so a provider-specific trust panel can be passed in
// without any provider-name branching here. Note the dot colour is never the
// only signal: the label always names the state.

import { useState, type ReactNode } from "react";
import { useStatusPopover } from "./useStatusPopover";
import type { ChatConnectionPhase } from "@threadterm/protocol";
import type { ComposerCopy } from "../composerOptions";
import { connectionChipLabel, connectionTone } from "../contextUsage";

export function ChatConnectionChip({
  phase,
  transportDown = false,
  providerName,
  providerVersion,
  cwd,
  nativeId,
  reconnectDisabled = false,
  onReconnect,
  copy,
  children,
}: {
  phase: ChatConnectionPhase;
  transportDown?: boolean;
  providerName: string;
  providerVersion?: string;
  cwd?: string;
  nativeId?: string;
  reconnectDisabled?: boolean;
  onReconnect?: () => void;
  copy: ComposerCopy;
  children?: ReactNode;
}) {
  const { open, toggle, anchor, trigger, dialog, id } = useStatusPopover();
  const [copied, setCopied] = useState<string>();
  const [copyFailed, setCopyFailed] = useState(false);

  const label = connectionChipLabel(phase, copy);
  const status = transportDown ? `${label} · ${copy("Offline", "离线")}` : label;
  const tone = connectionTone(phase, transportDown);
  const valueRow = (key: string, title: string, value: string) => (
    <div className="chat-status-row" key={key}>
      <span className="chat-status-key">{title}</span>
      <code className="chat-status-value" title={value}>{value}</code>
      <button
        type="button"
        className="btn btn-sm chat-status-copy"
        aria-label={`${copy("Copy", "复制")} ${title}`}
        onClick={async () => {
          setCopyFailed(false);
          try {
            if (!navigator.clipboard) throw new Error("Clipboard unavailable");
            await navigator.clipboard.writeText(value);
            setCopied(key);
          } catch { setCopyFailed(true); }
        }}
      >
        {copied === key ? copy("Copied", "已复制") : copy("Copy", "复制")}
      </button>
    </div>
  );

  return (
    <span className="chat-compose-anchor chat-status-anchor" ref={anchor}>
      <button
        type="button"
        ref={trigger}
        className={`chip chip-btn is-plain is-icon chat-compose-chip chat-status-chip chat-connection-chip is-${tone}`}
        data-status-trigger="connection"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${copy("Connection", "连接")}: ${status}`}
        title={`${copy("Connection", "连接")}: ${status}`}
        onClick={() => { setCopied(undefined); setCopyFailed(false); toggle(); }}
      >
        <span className="chat-connection-dot" aria-hidden="true" />
      </button>
      <span className="sr-only chat-connection-label" aria-hidden="true">{label}</span>
      {open && (
        <div className="chat-compose-menu chat-status-menu is-anchored" ref={dialog} id={id} tabIndex={-1} role="dialog" aria-label={copy("Connection details", "连接详情")}>
          <p className="chat-menu-label">{copy("Connection", "连接")}</p>
          <div className="chat-status-row">
            <span className="chat-status-key">{copy("State", "状态")}</span>
            <span className="chat-status-value">{status}</span>
          </div>
          {cwd && valueRow("cwd", copy("Working directory", "工作目录"), cwd)}
          {nativeId && valueRow("session", copy("Provider session", "Provider 会话"), nativeId)}
          <div className="chat-status-row">
            <span className="chat-status-key">{copy("Provider", "Provider")}</span>
            <span className="chat-status-value">{providerVersion ? `${providerName} ${providerVersion}` : providerName}</span>
          </div>
          {onReconnect && (
            <>
              <button type="button" className="btn btn-sm chat-status-reconnect" disabled={reconnectDisabled} onClick={onReconnect}>
                {copy("Reconnect", "重新连接")}
              </button>
              <p className="chat-status-warn">{copy("Reconnecting interrupts the current turn. Stop it first.", "重新连接会中断当前回合。请先停止。")}</p>
            </>
          )}
          {copyFailed && <p className="chat-status-warn" role="status">{copy("Could not copy. Try again.", "复制失败，请重试。")}</p>}
          {children}
        </div>
      )}
    </span>
  );
}
