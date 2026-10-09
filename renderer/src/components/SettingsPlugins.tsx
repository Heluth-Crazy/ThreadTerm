import { useEffect, useRef, useState } from "react";
import type { PluginInfo, PluginList } from "@threadterm/protocol";
import { openExternal, openPluginsFolder, operationId, request } from "../bridge";
import { SettingsSwitch } from "./SettingsControls";
import { SurfaceDialog } from "./SurfaceDialog";

export function pluginCommandLines(plugin: PluginInfo): string[] { return plugin.agents.flatMap(agent => agent.commands); }
function bindingAvailabilityLabel(availability: NonNullable<PluginInfo["browserBindings"]>[number]["availability"], zh: boolean): string {
  const labels = zh ? { eligible: "可用", disabled: "已禁用", unsupported_binding_version: "不支持的绑定版本", unsupported_runtime_capability: "不支持的运行时能力", unsupported_transport: "不支持的传输", conflict: "冲突" } : { eligible: "Available", disabled: "Disabled", unsupported_binding_version: "Unsupported binding version", unsupported_runtime_capability: "Unsupported runtime capability", unsupported_transport: "Unsupported transport", conflict: "Conflict" };
  return labels[availability];
}

export function SettingsPlugins({ zh, onSaved }: { zh: boolean; onSaved: () => Promise<void> }) {
  const [list, setList] = useState<PluginList>(), [confirm, setConfirm] = useState<PluginInfo>(), [busy, setBusy] = useState<string>(), [issue, setIssue] = useState<string>();
  const alive = useRef(true), locked = useRef(false), generation = useRef(0);
  const text = (cn: string, en: string) => zh ? cn : en;
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
  const load = async () => {
    const current = ++generation.current;
    try { const next = await request("plugin.list", {}); if (alive.current && current === generation.current) setList(next); }
    catch (error) { if (alive.current && current === generation.current) setIssue(errorMessage(error)); }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; generation.current++; };
  }, []);
  const run = (name: string, action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(name); setIssue(undefined);
    void action().catch(error => { if (alive.current) setIssue(errorMessage(error)); }).finally(() => { locked.current = false; if (alive.current) setBusy(undefined); });
  };
  const update = (plugin: PluginInfo, enabled: boolean) => run(`enabled-${plugin.id}`, async () => {
    generation.current++;
    const next = await request("plugin.setEnabled", { pluginId: plugin.id, enabled, operationId: operationId() });
    if (alive.current) { setList(next); setConfirm(undefined); }
    await onSaved();
  });
  const selectBinding = (plugin: PluginInfo, bindingId: string) => run(`binding-${plugin.id}-${bindingId}`, async () => {
    generation.current++;
    const next = await request("plugin.selectBrowserBinding", { pluginId: plugin.id, bindingId, operationId: operationId() });
    if (alive.current) setList(next);
    await onSaved();
  });
  const reload = () => run("reload", async () => {
    generation.current++;
    const next = await request("plugin.reload", { operationId: operationId() });
    if (alive.current) setList(next);
    await onSaved();
  });
  const openFolder = () => run("folder", async () => { await openPluginsFolder(); });
  return <section className="settings-plugins">
    <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{text("插件", "Plugins")}</div><p>{text("从此目录安装用户插件。启用插件前会显示它可能运行的命令。", "Install user plugins in this directory. ThreadTerm shows commands a plugin may run before you enable it.")}</p>{list && <p><code>{list.directory}</code></p>}</div><div className="inline-actions"><button className="btn-subtle" type="button" disabled={Boolean(busy)} onClick={openFolder}>{busy === "folder" ? text("正在打开…", "Opening…") : text("打开插件文件夹", "Open plugins folder")}</button><button className="btn-subtle" type="button" disabled={Boolean(busy)} onClick={reload}>{busy === "reload" ? text("正在重新加载…", "Reloading…") : text("重新加载", "Reload")}</button></div></div></div>
    {list?.plugins.map(plugin => <div className="settings-card" key={plugin.id}><div className="settings-card-row"><div><div className="settings-card-title">{plugin.name} <small>{plugin.version}</small></div><p>{plugin.publisher && <>{plugin.publisher} · </>}<span className="sheet-card-tag">{plugin.source === "bundled" ? text("内置", "Bundled") : text("用户", "User")}</span></p>{plugin.description && <p>{plugin.description}</p>}{plugin.homepage && <button className="btn-subtle" type="button" disabled={Boolean(busy)} onClick={() => void openExternal(plugin.homepage!).catch(error => setIssue(errorMessage(error)))}>{text("打开主页", "Open homepage")}</button>}</div><SettingsSwitch checked={plugin.enabled} disabled={Boolean(busy)} onChange={enabled => { if (enabled && plugin.source === "user") setConfirm(plugin); else update(plugin, enabled); }}>{plugin.enabled ? text("已启用", "Enabled") : text("已禁用", "Disabled")}</SettingsSwitch></div>
      {plugin.agents.length > 0 && <div><p>{text("代理", "Agents")}</p>{plugin.agents.map(agent => <div className="tool-row" key={agent.id}><span><b>{agent.name}</b><small>{agent.terminal && text("终端", "Terminal")}{agent.terminal && agent.chat && " · "}{agent.chat && text("ACP 聊天", "ACP Chat")}</small>{agent.commands.map((command, index) => <code key={`${index}-${command}`}>{command}</code>)}</span></div>)}</div>}
      {plugin.browserBindings?.length ? <div><p>{text("浏览器工具绑定", "Browser tool bindings")}</p>{plugin.browserBindings.map(binding => <div className="tool-row" key={binding.id}><span><b>{binding.id}</b><small>{binding.providerId} · {binding.transport} · {bindingAvailabilityLabel(binding.availability, zh)}</small><code>{binding.workflow}</code></span>{binding.availability === "conflict" && plugin.enabled && <button className="btn-subtle" type="button" disabled={Boolean(busy)} onClick={() => selectBinding(plugin, binding.id)}>{binding.selected ? text("已选择", "Selected") : text("使用此绑定", "Use this binding")}</button>}</div>)}</div> : null}
      {plugin.issues.map((value, index) => <p className="surface-error" role="alert" key={`${index}-${value}`}>{value}</p>)}</div>)}
    {list && !list.plugins.length && <p className="hint">{text("尚未找到插件。", "No plugins found.")}</p>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
    {confirm && <SurfaceDialog title={text("启用用户插件？", "Enable user plugin?")} subtitle={confirm.name} icon="shield" size="sm" className="plugin-trust" onClose={() => { if (!busy) setConfirm(undefined); }} footer={<><button className="btn" type="button" disabled={Boolean(busy)} onClick={() => setConfirm(undefined)}>{text("取消", "Cancel")}</button><button className="btn btn-primary" type="button" disabled={Boolean(busy)} onClick={() => update(confirm, true)}>{text("启用", "Enable")}</button></>}><p>{text("只启用你信任的插件。该插件可能运行以下命令：", "Only enable plugins you trust. This plugin may run these commands:")}</p>{pluginCommandLines(confirm).map((command, index) => <code key={`${index}-${command}`}>{command}</code>)}{issue && <p className="surface-error" role="alert">{issue}</p>}</SurfaceDialog>}
  </section>;
}
