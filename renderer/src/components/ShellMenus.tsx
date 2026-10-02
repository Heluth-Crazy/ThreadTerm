import { Select } from "./ui/Select";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Snapshot } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { isActionableInboxItem } from "../inboxVisibility";
import { Icon } from "./PrototypeIcon";
import { useTranslation } from "../i18n";
import "./shell-menus.css";

type MenuBase = { data: Snapshot; onClose: () => void; onChanged: () => void; anchor?: HTMLElement | null };
const position = (anchor?: HTMLElement | null, above = false) => {
  if (!anchor) return undefined;
  const box = anchor.getBoundingClientRect();
  return { top: above ? Math.max(8, box.top - 6) : Math.min(innerHeight - 8, box.bottom + 6), left: Math.max(8, Math.min(innerWidth - 348, box.right - 340)) };
};
function useDismiss(onClose: () => void, anchor?: HTMLElement | null) {
  const root = useRef<HTMLElement>(null); const restore = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => { root.current?.querySelector<HTMLElement>("button,select")?.focus(); const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) onClose(); }; const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }; addEventListener("pointerdown", dismiss); addEventListener("keydown", key); return () => { removeEventListener("pointerdown", dismiss); removeEventListener("keydown", key); restore.current?.focus(); }; }, [anchor, onClose]);
  return root;
}

export function NotificationMenu({ data, onClose, onChanged, onSession, onInbox, anchor }: MenuBase & { onSession: (id: string) => void; onInbox: () => void }) {
  const { locale } = useTranslation(); const zh = locale === "zh-CN"; const copy = (en: string, cn: string) => zh ? cn : en; const root = useDismiss(onClose, anchor);
  const [issue, setIssue] = useState<string>();
  const unread = data.inbox.filter(item => isActionableInboxItem(item));
  const read = async (ids: string[], sessionId?: string) => {
    if (!ids.length) { if (sessionId) onSession(sessionId); return; }
    try { await request("inbox.read", { ids, operationId: operationId() }); onChanged(); if (sessionId) onSession(sessionId); }
    catch (error) { setIssue(error instanceof Error ? error.message : copy("Unable to mark notification read.", "无法将通知标为已读。")); }
  };
  return createPortal(<aside ref={root} className="popover shell-menu notification-popover" style={position(anchor)} aria-label={copy("Notifications", "通知")}>
    <header className="shell-menu-head"><strong>{copy("Notifications · needs your attention", "通知 · 需要你处理的事项")}</strong><button className="icon-btn" aria-label={copy("Close notifications", "关闭通知")} onClick={onClose}><Icon name="close" /></button></header>
    {issue && <p className="surface-error" role="alert">{issue}</p>}
    <div className="notif-list">{data.inbox.slice(0, 12).map(item => <button className="notif-row notif-item" key={item.id} onClick={() => void read(item.read ? [] : [item.id], item.sessionId)}><span className={item.read ? "read-dot" : "unread-dot"} /><span><strong>{item.title}</strong><p>{({ approval: copy("Approval", "需要批准"), error: copy("Error", "错误"), waiting: copy("Waiting", "等待"), reply: copy("Reply", "回复") }[item.kind] ?? item.kind)} · {new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(item.createdAt))}</p></span></button>)}{!data.inbox.length && <p className="shell-menu-empty">{copy("No notifications.", "暂时没有需要处理的事项。")}</p>}</div>
    <footer className="shell-menu-foot"><button className="menu-item" onClick={() => void read(unread.map(item => item.id))}>{copy("Mark all read", "全部标为已读")}</button><button className="menu-item" onClick={onInbox}>{copy("Open inbox", "查看全部待处理")}</button></footer>
  </aside>, document.body);
}

export function AccountMenu({ data, onClose, onSettings, onChanged, anchor }: MenuBase & { onSettings: () => void }) {
  const { locale } = useTranslation(); const zh = locale === "zh-CN"; const copy = (en: string, cn: string) => zh ? cn : en; const root = useDismiss(onClose, anchor);
  const [issue, setIssue] = useState<string>();
  const language = data.settings.language === "en" ? "en" : "zh-CN";
  const theme = data.settings.theme === "light" || data.settings.theme === "dark" ? data.settings.theme : "system";
  const [busy, setBusy] = useState(false); const update = async (patch: Record<string, unknown>) => {
    if (busy) return; setBusy(true);
    try { await request("settings.update", { patch, expectedRevision: data.settings.revision, operationId: operationId() }); onChanged(); }
    catch (error) { setIssue(error instanceof Error ? error.message : copy("Unable to save settings.", "无法保存设置。")); }
    finally { setBusy(false); }
  };
  const label = typeof data.settings.localUserLabel === "string" && data.settings.localUserLabel.trim() ? data.settings.localUserLabel : copy("Local user", "本地用户");
  return createPortal(<aside ref={root} className="popover shell-menu account-menu shell-menu-above" style={position(anchor, true)} aria-label={copy("Local account", "本地账户")}>
    <header className="account-row"><span className="avatar account-avatar">本</span><span><strong>{label}</strong><small>{copy("Local profile", "本地配置")}</small></span><button className="icon-btn" aria-label={copy("Close account menu", "关闭账户菜单")} onClick={onClose}><Icon name="close" /></button></header>
    {issue && <p className="surface-error" role="alert">{issue}</p>}
    <div className="menu-label">{copy("Appearance", "外观")}</div><button className="menu-item" disabled={busy} onClick={() => void update({ theme: "light", themeSelection: "light" })}><Icon name="sun" />{copy("Light (warm)", "浅色（暖米）")}<span className="dim">{theme === "light" ? "✓" : ""}</span></button><button className="menu-item" disabled={busy} onClick={() => void update({ theme: "dark", themeSelection: "dark" })}><Icon name="moon" />{copy("Dark (charcoal)", "深色（炭黑）")}<span className="dim">{theme === "dark" ? "✓" : ""}</span></button><button className="menu-item" disabled={busy} onClick={() => void update({ theme: "system", themeSelection: "system" })}><Icon name="sun" />{copy("System", "跟随系统")}<span className="dim">{theme === "system" ? "✓" : ""}</span></button><div className="menu-sep" />
    <label className="shell-menu-field">{copy("Language", "语言")}<Select disabled={busy} value={language} onChange={event => void update({ language: event.target.value })}><option value="zh-CN">简体中文</option><option value="en">English</option></Select></label>
    <footer className="shell-menu-foot"><button className="menu-item" onClick={onSettings}><Icon name="gear" />{copy("Settings", "设置")}</button></footer>
  </aside>, document.body);
}
