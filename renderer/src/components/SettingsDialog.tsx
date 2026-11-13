import { localeFromSettings } from "../i18n";
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
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
const settingsGlyphs: Record<Tab,string> = {"appearance": "<circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"M12 4a8 8 0 0 1 0 16z\" fill=\"currentColor\"/>", "controls": "<rect x=\"2.5\" y=\"6\" width=\"19\" height=\"12\" rx=\"2.5\"/><path d=\"M6.5 9.8h.01M9.5 9.8h.01M12.5 9.8h.01M15.5 9.8h.01M18 9.8h.01M7 14.3h10\"/>", "terminal": "<rect x=\"3\" y=\"4.5\" width=\"18\" height=\"15\" rx=\"3\"/><path d=\"m7.5 9.5 2.6 2.5-2.6 2.5M12.8 14.5h3.8\"/>", "browser": "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5s1.1-6.1 3.5-8.5z\"/>", "agents": "<circle cx=\"9\" cy=\"8.5\" r=\"3\"/><path d=\"M3.5 19a5.5 5.5 0 0 1 11 0\"/><circle cx=\"16.5\" cy=\"9.5\" r=\"2.4\"/><path d=\"M15.6 14.2a4.5 4.5 0 0 1 4.9 4.8\"/>", "tools": "<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a6 6 0 0 1-7.9 7.9l-6.3 6.3a2.1 2.1 0 0 1-3-3l6.3-6.3a6 6 0 0 1 7.9-7.9z\"/>", "plugins": "<path d=\"M10 5a2 2 0 0 1 4 0v1.5h3.5A1.5 1.5 0 0 1 19 8v3.5h-1.5a2 2 0 0 0 0 4H19V19a1.5 1.5 0 0 1-1.5 1.5H14V19a2 2 0 0 0-4 0v1.5H6.5A1.5 1.5 0 0 1 5 19v-3.5h1.5a2 2 0 0 0 0-4H5V8a1.5 1.5 0 0 1 1.5-1.5H10z\"/>", "computers": "<rect x=\"3\" y=\"4.5\" width=\"18\" height=\"12\" rx=\"2\"/><path d=\"M9 20h6M12 16.5V20\"/>", "mobile": "<rect x=\"7\" y=\"2.5\" width=\"10\" height=\"19\" rx=\"2.5\"/><path d=\"M11 18.5h2\"/>", "data": "<ellipse cx=\"12\" cy=\"6\" rx=\"7\" ry=\"2.5\"/><path d=\"M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5\"/>", "usage": "<path d=\"M4.5 19.5h15M7.5 16v-5M12 16V6.5M16.5 16v-8\"/>"};
type Props = { initialTab?: Tab; data: Snapshot; onClose: () => void; onSaved: () => Promise<void>; onSessionCreated?: (id: string) => void | Promise<void>; onOpenSession?: (id: string) => void; supervisionCounts: { checks: number; alertCount: number } };
export function SettingsDialog({ initialTab = "appearance", data, onClose, onSaved, onSessionCreated, onOpenSession, supervisionCounts }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [search, setSearch] = useState("");
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
  const groups:Tab[][] = [['appearance','controls','terminal','browser'],['agents','tools','plugins'],['computers','mobile'],['data','usage']];
  const colors:Record<Tab,string>={appearance:'#1c1c1e',controls:'#8e8e93',terminal:'#3a3a3c',browser:'#007aff',agents:'#5856d6',tools:'#8e8e93',plugins:'#af52de',computers:'#0a84ff',mobile:'#34c759',data:'#30b0c7',usage:'#ff9500'};
  const visible=(item:Tab)=>(item!=='terminal'||window.threadterm.platform==='win32')&&settingsPageVisible(item,remote)&&`${names[item]} ${item}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const visibleTabs=groups.flat().filter(visible);
  return createPortal(<div className="settings-drawer" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><section ref={panel} tabIndex={-1} className="settings-panel mac-settings-window" role="dialog" aria-modal="true" aria-label={zh ? "设置" : "Settings"}>
    <aside className="mac-settings-side">
      <label className="mac-settings-search"><Icon name="search"/><input type="search" aria-label={zh?'搜索设置':'Search settings'} placeholder={zh?'搜索':'Search'} value={search} onChange={event=>setSearch(event.target.value)}/></label>
      <div className="mac-settings-account"><span className="avatar">LU</span><span><b>{zh?'本地用户':'Local user'}</b><small>{zh?'本地配置':'Local profile'}</small></span></div>
      <nav role="tablist" aria-label={zh?'设置页面':'Settings pages'} aria-orientation="vertical" onKeyDown={event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||!visibleTabs.length)return;event.preventDefault();const focused=(event.target as HTMLElement).closest<HTMLElement>('[data-settings-tab]')?.dataset.settingsTab as Tab|undefined,index=visibleTabs.indexOf(focused??tab),next=visibleTabs[event.key==='Home'?0:event.key==='End'?visibleTabs.length-1:(index+(event.key==='ArrowDown'?1:-1)+visibleTabs.length)%visibleTabs.length];setTab(next);requestAnimationFrame(()=>panel.current?.querySelector<HTMLElement>(`#settings-tab-${next}`)?.focus());}}>
       {groups.map((group,index)=><div className="mac-settings-nav-group" role="presentation" key={index}>{group.filter(visible).map(item=><button key={item} id={`settings-tab-${item}`} data-settings-tab={item} role="tab" className={`mac-settings-nav-item${tab===item?' active':''}`} aria-selected={tab===item} tabIndex={tab===item||(!visibleTabs.includes(tab)&&item===visibleTabs[0])?0:-1} onClick={()=>setTab(item)}><span className="mac-settings-tile" style={{'--settings-tile-color':colors[item]} as CSSProperties}><svg className="ico" viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{__html:settingsGlyphs[item]}}/></span><span>{names[item]}</span></button>)}</div>)}
       {!visibleTabs.length&&<p className="side-empty" role="status">{zh?'没有匹配的设置':'No matching settings'}</p>}
      </nav>
    </aside>
    <header className="mac-settings-bar"><h2>{names[tab]}</h2><button type="button" className="icon-btn settings-close" onClick={onClose} aria-label={zh?'关闭设置':'Close settings'} title={zh?'关闭':'Close'}><svg viewBox="0 0 10 10" aria-hidden="true"><path d="m.5.5 9 9m0-9-9 9"/></svg></button></header>
    <div className="settings-body settings-scroll">
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
    </div>
  </section></div>, document.body);
}
