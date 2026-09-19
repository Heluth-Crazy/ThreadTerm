import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Preset, Snapshot } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { useModalFocus } from "../useModalFocus";
import { Icon } from "./PrototypeIcon";
import { SettingsTools } from "./SettingsTools";
import { ProviderNetworkSettings } from "./ProviderNetworkSettings";
import { DeviceSettings } from "./DeviceSettings";
import { SettingsAppearance } from "./SettingsAppearance";
import { SettingsControls } from "./SettingsControls";
import { SettingsData } from "./SettingsData";
import "../../../reference/prototype/features/settings.css";
import "./settings-parity.css";

type Tab = "appearance" | "controls" | "data" | "mobile" | "tools";
type Props = { data: Snapshot; currentWorkspace?: Pick<Preset, "layout" | "sessions">; onClose: () => void; onSaved: () => Promise<void>; onSessionCreated?: (id: string) => void | Promise<void>; supervisionCounts: { checks: number; alertCount: number } };
export function SettingsDialog({ data, onClose, onSaved, onSessionCreated, supervisionCounts }: Props) {
  const [tab, setTab] = useState<Tab>("appearance");
  const panel = useRef<HTMLElement>(null), revision = useRef(data.settings.revision);
  useModalFocus(panel, onClose);
  useEffect(() => { revision.current = data.settings.revision; }, [data.settings.revision]);
  const zh = data.settings.language !== "en";
  const update = async (patch: Record<string, unknown>) => {
    const next = await request("settings.update", { patch, expectedRevision: revision.current, operationId: operationId() });
    revision.current = next.revision;
    await onSaved();
  };
  const names: Record<Tab, string> = zh ? { appearance: "外观", controls: "快捷键", data: "数据", mobile: "移动", tools: "工具" } : { appearance: "Appearance", controls: "Shortcuts", data: "Data", mobile: "Mobile", tools: "Tools" };
  return createPortal(<div className="settings-drawer" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><section ref={panel} tabIndex={-1} className="settings-panel" role="dialog" aria-modal="true" aria-label={zh ? "设置" : "Settings"}>
    <header><div className="settings-brand"><span className="settings-brand-ico"><Icon name="settings" /></span><div><p>ThreadTerm</p><h2>{zh ? "设置" : "Settings"}</h2></div></div><button className="btn-subtle" onClick={onClose} aria-label={zh ? "关闭设置" : "Close settings"}>×</button></header>
    <div className="settings-layout"><nav role="tablist">{(Object.keys(names) as Tab[]).map(item => <button key={item} role="tab" className={tab === item ? "active" : ""} aria-selected={tab === item} onClick={() => setTab(item)}>{names[item]}</button>)}</nav><div className="settings-scroll">
      <section className={`settings-group ${tab === "appearance" ? "active" : ""}`}><SettingsAppearance settings={data.settings} zh={zh} update={update} /></section>
      <section className={`settings-group ${tab === "controls" ? "active" : ""}`}><SettingsControls settings={data.settings} zh={zh} update={update} counts={supervisionCounts} /></section>
      <section className={`settings-group ${tab === "data" ? "active" : ""}`}><SettingsData settings={data.settings} zh={zh} onSaved={onSaved} /></section>
      <section className={`settings-group ${tab === "mobile" ? "active" : ""}`}><DeviceSettings language={zh ? "zh-CN" : "en"} /></section>
      <section className={`settings-group ${tab === "tools" ? "active" : ""}`}><ProviderNetworkSettings settings={data.settings} zh={zh} update={update} /><SettingsTools data={data} onSaved={onSaved} /></section>
    </div></div>
  </section></div>, document.body);
}
