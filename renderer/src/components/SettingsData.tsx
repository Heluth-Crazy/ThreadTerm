import { useEffect, useRef, useState } from "react";
import type { DataRelocationPrepared, DataStatus, Settings } from "@threadterm/protocol";
import { activateDataRelocation, chooseDirectory, chooseSavePath, exportDiagnostics, operationId, request, scheduleElectronCacheCleanup } from "../bridge";
import { SurfaceDialog } from "./SurfaceDialog";
import { SettingsSwitch } from "./SettingsControls";

function download(value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "threadterm-settings.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
const showValue = (value: unknown) => value === undefined ? "—" : JSON.stringify(value, null, 2);
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
export function SettingsData({ settings, zh, onSaved }: { settings: Settings; zh: boolean; onSaved: () => Promise<void> }) {
  const [status, setStatus] = useState<DataStatus>(), [busy, setBusy] = useState(false), [issue, setIssue] = useState<string>(), [notice, setNotice] = useState<string>();
  const [bundle, setBundle] = useState(""), [preview, setPreview] = useState<Awaited<ReturnType<typeof request<"settings.import.preview">>>>(), [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState(""), [prepared, setPrepared] = useState<{ value: DataRelocationPrepared; operation: string }>(), [migrationState, setMigrationState] = useState("idle");
  const pending = useRef(prepared); pending.current = prepared;
  const text = (cn: string, en: string) => zh ? cn : en;
  const refresh = async () => setStatus(await request("data.status", {}));
  useEffect(() => { let live = true; void request("data.status", {}).then(value => { if (live) setStatus(value); }).catch(error => { if (live) setIssue(String(error)); }); return () => { live = false; const operation = pending.current?.operation; if (operation) void request("data.relocation.cancel", { preparedOperationId: operation, operationId: operationId() }).catch(() => undefined); }; }, []);
  const run = (action: () => Promise<void>) => { if (busy) return; setBusy(true); setIssue(undefined); void action().catch(error => setIssue(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false)); };
  const cancel = async () => { if (!prepared) return; await request("data.relocation.cancel", { preparedOperationId: prepared.operation, operationId: operationId() }); pending.current = undefined; setPrepared(undefined); setMigrationState("cancelled"); };
  const activate = async () => {
    if (!prepared) return;
    try {
      const result = await activateDataRelocation(prepared.value);
      if (!result.activated) throw new Error(text("数据位置未切换。", "Data location was not changed."));
      pending.current = undefined; setPrepared(undefined);
    } catch (error) { await cancel().catch(() => undefined); throw error; }
  };
  const inspect = () => run(async () => {
    setMigrationState("checking");
    try { const operation = operationId(); const value = await request("data.relocation.prepare", { targetPath: target.trim(), operationId: operation }); const ready = { value, operation }; pending.current = ready; setPrepared(ready); setMigrationState("prepared"); }
    catch (error) { setMigrationState("failed"); throw error; }
  });
  const cache = settings.electronCacheCleanup as { state?: string; message?: string } | undefined;
  return <>
    <h3>{text("数据、导入与迁移", "Data, import & migration")}</h3><p>{status?.root ?? text("正在加载数据清单…", "Loading data inventory…")}</p>
    <table className="settings-table"><thead><tr><th>{text("类别", "Category")}</th><th>{text("大小", "Size")}</th><th>{text("项目", "Items")}</th></tr></thead><tbody>
      <tr><td>{text("会话与项目数据库", "Session & project database")}</td><td>{status ? bytes(status.database.sizeBytes) : "—"}</td><td>{status?.counts.sessions ?? "—"}</td></tr>
      <tr><td>{text("工作区草稿", "Workspace drafts")}</td><td>{text("计入数据库", "Included in database")}</td><td>{status?.counts.drafts ?? "—"}</td></tr>
      <tr><td>{text("主题和偏好", "Themes & preferences")}</td><td>{text("计入数据库", "Included in database")}</td><td>{Object.keys(settings).filter(key => key !== "revision").length}</td></tr>
      <tr><td>{text("可重建缓存", "Rebuildable cache")}</td><td>—</td><td>—</td></tr>
    </tbody></table>
    {window.threadterm.platform === "win32" ? <SettingsSwitch disabled={busy} checked={cache?.state === "scheduled"} onChange={value => run(async () => { await scheduleElectronCacheCleanup(value); await onSaved(); })}>{text("下次启动时重建可重建缓存", "Rebuild cache next start")}</SettingsSwitch> : <p className="hint">{text("此平台的浏览器缓存由系统管理。", "Browser cache is managed by the system on this platform.")}</p>}
    {cache?.state === "failed" && <p className="surface-error">{cache.message}</p>}
    <div className="setting-divider" />
    <p>{text("设置包包含主题、语言、通知、快捷键与终端兼容偏好；不包含会话、输出、密钥、配对设备或审计记录。", "Settings bundles include themes, language, notifications, shortcuts and terminal compatibility. They exclude sessions, output, keys, paired devices and audit history.")}</p>
    <button className="btn-subtle" disabled={busy} onClick={() => run(async () => { download(await request("settings.export", {})); setNotice(text("已下载设置 JSON。", "Settings JSON downloaded.")); })}>{text("下载设置 JSON", "Download settings JSON")}</button>
    <label>{text("粘贴设置 JSON 以导入", "Paste settings JSON to import")}<textarea value={bundle} onChange={event => { setBundle(event.target.value); setPreview(undefined); setSelected([]); }} placeholder='{"marker":"threadterm-v3-settings", ...}' /></label>
    <button className="btn-subtle" disabled={busy || !bundle.trim()} onClick={() => run(async () => { const value = await request("settings.import.preview", { bundle }); setPreview(value); setSelected(value.valid ? value.changes.map(change => change.key) : []); })}>{text("验证并查看差异", "Validate & preview differences")}</button>
    {preview && <div className="import-preview">{preview.valid ? <><p>{preview.changes.length ? text("选择要导入的栏目。", "Select the sections to import.") : text("设置没有差异。", "There are no settings differences.")}</p>{preview.changes.map(change => <label key={change.key}><span><input type="checkbox" checked={selected.includes(change.key)} onChange={() => setSelected(items => items.includes(change.key) ? items.filter(key => key !== change.key) : [...items, change.key])} />{change.key}</span><div className="settings-import-diff"><pre>{showValue(change.current)}</pre><span>→</span><pre>{showValue(change.incoming)}</pre></div></label>)}<button className="btn-subtle" disabled={busy || !selected.length} onClick={() => run(async () => { await request("settings.import.apply", { bundle, selected, expectedRevision: preview.currentRevision, operationId: operationId() }); setPreview(undefined); setSelected([]); await onSaved(); setNotice(text("已应用所选栏目。", "Selected sections applied.")); })}>{text("应用所选栏目", "Apply selected sections")}</button></> : <p className="surface-error" role="alert">{preview.issues.join(" · ")}</p>} <button className="btn-subtle" disabled={busy} onClick={() => { setPreview(undefined); setSelected([]); }}>{text("取消", "Cancel")}</button></div>}
    <div className="setting-divider" />
    <label>{text("迁移目标", "Migration target")}<div className="settings-path-row"><input value={target} disabled={busy || !!prepared} onChange={event => { setTarget(event.target.value); setMigrationState("idle"); }} placeholder={text("选择一个已有的空目录", "Choose an existing empty directory")} /><button className="btn-subtle" disabled={busy || !!prepared} onClick={() => run(async () => { const path = await chooseDirectory(); if (path) { setTarget(path); setMigrationState("idle"); } })}>{text("选择目录", "Choose folder")}</button></div></label>
    <SettingsSwitch checked disabled onChange={() => undefined}>{text("迁移后保留源数据", "Retain source data after migration")}</SettingsSwitch>
    <p className="hint">{text("先结束运行中的会话。预检会校验目标并准备数据副本，确认后切换并重启应用。源目录始终保留。", "End active sessions first. Precheck validates the target and prepares a copy; confirmation switches the data location and restarts the app. The source is retained.")}</p>
    <div className="inline-actions"><button className="btn-subtle" disabled={busy || !target.trim() || !!prepared} onClick={inspect}>{text("运行预检", "Run precheck")}</button><button className="btn-subtle" disabled={busy || !prepared} onClick={() => run(activate)}>{text("开始迁移", "Start migration")}</button><button className="btn-subtle" disabled={busy || !prepared} onClick={() => run(cancel)}>{text("取消", "Cancel")}</button><button className="btn-subtle" disabled={busy || !prepared} onClick={() => run(cancel)}>{text("回滚", "Rollback")}</button></div>
    <div className="migration-state"><progress max="100" {...(busy && migrationState === "checking" ? {} : { value: migrationState === "prepared" ? 100 : 0 })} /><span>{({ idle: text("尚未运行预检", "Precheck not run"), checking: text("正在校验并准备副本…", "Validating and preparing a copy…"), prepared: text("已准备，等待确认", "Prepared, awaiting confirmation"), cancelled: text("已取消，继续使用源目录；目标副本保留。", "Cancelled; the source remains active and the target copy is retained."), failed: text("预检失败，请检查错误后重试。", "Precheck failed. Review the error and retry.") } as Record<string, string>)[migrationState]}</span></div>
    <div className="setting-divider" /><div className="inline-actions"><button className="btn-subtle" disabled={busy} onClick={() => run(async () => { const targetPath = await chooseSavePath("database"); if (targetPath) { const result = await request("data.backup", { targetPath, operationId: operationId() }); setNotice(`${text("备份已保存", "Backup saved")}: ${result.path}`); await refresh(); } })}>{text("备份数据库", "Back up database")}</button><button className="btn-subtle" disabled={busy} onClick={() => run(async () => { const path = await exportDiagnostics(); if (path) setNotice(path); })}>{text("导出诊断", "Export diagnostics")}</button></div>
    {notice && <p role="status">{notice}</p>}{issue && <p className="surface-error" role="alert">{issue}</p>}
    {prepared && <SurfaceDialog title={text("确认数据迁移", "Confirm data relocation")} icon="folder" size="sm" onClose={() => { if (!busy) run(cancel); }} footer={<><button className="btn" disabled={busy} onClick={() => run(cancel)}>{text("取消", "Cancel")}</button><button className="btn btn-primary" disabled={busy} onClick={() => run(activate)}>{text("切换并重启", "Switch & restart")}</button></>}><div className="settings-relocation-review"><p>{text("当前目录", "Current location")}</p><code>{prepared.value.sourceRoot}</code><p>{text("已准备的目标", "Prepared target")}</p><code>{prepared.value.targetRoot}</code><p>{text("源数据将保留。取消时继续使用当前目录，已准备的副本也会保留。", "The source data is retained. Cancelling keeps the current location active and retains the prepared copy.")}</p>{issue && <p className="surface-error" role="alert">{issue}</p>}</div></SurfaceDialog>}
  </>;
}
