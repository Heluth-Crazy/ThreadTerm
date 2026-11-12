import { localeFromSettings } from "../i18n";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Session } from "@threadterm/protocol";
import { presentationRequest } from "../presentation";
import { createPortal } from "react-dom";
import type { Snapshot } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { useModalFocus } from "../useModalFocus";
import { Icon } from "./PrototypeIcon";
import { SettingsTools } from "./SettingsTools";
import { SettingsChatTools } from "./SettingsChatTools";
import { ProviderNetworkSettings } from "./ProviderNetworkSettings";
import { DeviceSettings } from "./DeviceSettings";
import { MachineSettings } from './MachineSettings';
import { settingsPageVisible, useMachines } from '../machines';
import { SettingsAppearance } from "./SettingsAppearance";
import { SettingsControls } from "./SettingsControls";
import { SettingsTerminal } from "./SettingsTerminal";
import { SettingsQuickMessages } from "./SettingsQuickMessages";
import { SettingsTerminalIcons } from "./SettingsTerminalIcons";
import { SettingsData } from "./SettingsData";
import { SettingsPlugins } from "./SettingsPlugins";
import { SettingsUsage } from "./SettingsUsage";
import { SettingsBrowser } from './SettingsBrowser';
// Agents carries the Astryx chunk; it loads when the tab opens.
const AgentsSettings = lazy(() => import("./AgentsSettings"));
import { useBrowserOcclusion } from '../browserOcclusion';
import "../../../reference/prototype/features/settings.css";
import "./settings-parity.css";

type Tab = "appearance" | "agents" | "controls" | "terminal" | "browser" | "data" | "mobile" | "computers" | "tools" | "plugins" | "usage";
type Props = { initialTab?: Tab; data: Snapshot; onClose: () => void; onSaved: () => Promise<void>; onSessionCreated?: (id: string) => void | Promise<void>; onOpenSession?: (id: string) => void; supervisionCounts: { checks: number; alertCount: number } };
export function SettingsDialog({ initialTab = "appearance", data, onClose, onSaved, onSessionCreated, onOpenSession, supervisionCounts }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const machine = useMachines(), remote = machine.currentId !== 'local';
  useEffect(() => { if (!settingsPageVisible(tab, remote)) setTab('appearance'); }, [tab, remote]);
  const panel = useRef<HTMLElement>(null), revision = useRef(data.settings.revision);
  useModalFocus(panel, onClose);
  useBrowserOcclusion();
  useEffect(() => { revision.current = data.settings.revision; }, [data.settings.revision]);
  const zh = localeFromSettings(data.settings) === "zh-CN";
  const update = async (patch: Record<string, unknown>) => {
    const next = await request("settings.update", { patch, expectedRevision: revision.current, operationId: operationId() });
    revision.current = next.revision;
    await onSaved();
  };
  // A sign-in terminal opens focused in the workspace, as it did from the old accounts panel.
  const presentSignIn = async (session: Session) => {
    const config = await request("session.config.read", { sessionId: session.id });
    const shown = presentationRequest({ sessionId: session.id, presentation: "focused", workspacePath: session.worktreePath ?? config.cwd });
    if (!shown) throw new Error(zh ? "无法显示登录终端。" : "The sign-in terminal could not be shown.");
    await request("session.present", { ...shown, placement: "workspace", operationId: operationId() });
    await onSaved();
  };
  const names: Record<Tab, string> = zh ? { appearance: "外观", agents: "智能体", controls: "快捷键", terminal: "终端", browser: "浏览器", data: "数据", mobile: "手机", computers: "电脑", tools: "工具", plugins: "插件", usage: "用量" } : { appearance: "Appearance", agents: "Agents", controls: "Shortcuts", terminal: "Terminal", browser: "Browser", data: "Data", mobile: "Phones", computers: "Computers", tools: "Tools", plugins: "Plugins", usage: "Usage" };
  return createPortal(<div className="settings-drawer" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><section ref={panel} tabIndex={-1} className="settings-panel" role="dialog" aria-modal="true" aria-label={zh ? "设置" : "Settings"}>
    <header><div className="settings-brand"><span className="settings-brand-ico"><Icon name="settings" /></span><div><p>ThreadTerm</p><h2>{zh ? "设置" : "Settings"}</h2></div></div><button type="button" className="icon-btn settings-close" onClick={onClose} aria-label={zh ? "关闭设置" : "Close settings"} title={zh ? "关闭" : "Close"}><Icon name="close" /></button></header>
    <div className="settings-layout"><nav role="tablist">{(Object.keys(names) as Tab[]).filter(item => (item !== "terminal" || window.threadterm.platform === "win32") && settingsPageVisible(item, remote)).map(item => <button key={item} role="tab" className={tab === item ? "active" : ""} aria-selected={tab === item} onClick={() => setTab(item)}>{names[item]}</button>)}</nav><div className="settings-scroll">
      <section className={`settings-group ${tab === "appearance" ? "active" : ""}`}><SettingsAppearance settings={data.settings} zh={zh} update={update} /><SettingsTerminalIcons settings={data.settings} zh={zh} update={update} /></section>
      <section className={`settings-group ${tab === "controls" ? "active" : ""}`}><SettingsControls settings={data.settings} zh={zh} update={update} counts={supervisionCounts} /><SettingsQuickMessages settings={data.settings} zh={zh} update={update} /></section>
      {tab === "terminal" && window.threadterm.platform === "win32" && <section className="settings-group active"><SettingsTerminal settings={data.settings} zh={zh} update={update} /></section>}
      {tab === "browser" && <section className="settings-group active"><SettingsBrowser zh={zh} settings={data.settings} update={update} /></section>}
      {!remote && <section className={`settings-group ${tab === "data" ? "active" : ""}`}><SettingsData settings={data.settings} zh={zh} onSaved={onSaved} active={tab === "data"} sessions={data.sessions} projects={data.projects} onOpenSession={onOpenSession} /></section>}
      {!remote && <section className={`settings-group ${tab === "mobile" ? "active" : ""}`}><DeviceSettings language={zh ? "zh-CN" : "en"} active={tab === "mobile"} /></section>}
      {!remote && tab === 'computers' && <section className="settings-group active"><MachineSettings settings={data.settings} zh={zh} update={update} /></section>}
      {tab === "agents" && <section className="settings-group active"><Suspense fallback={<p role="status">{zh ? "正在加载…" : "Loading…"}</p>}><AgentsSettings data={data} zh={zh} onSignInSession={presentSignIn} /></Suspense><ProviderNetworkSettings settings={data.settings} zh={zh} update={update} /></section>}
      <section className={`settings-group ${tab === "tools" ? "active" : ""}`}><SettingsChatTools settings={data.settings} zh={zh} update={update} /><SettingsTools data={data} onSaved={onSaved} /></section>
      {tab === "plugins" && <section className="settings-group active"><SettingsPlugins zh={zh} onSaved={onSaved} /></section>}
      {tab === "usage" && <section className="settings-group active"><SettingsUsage zh={zh} data={data} /></section>}
    </div></div>
  </section></div>, document.body);
}
