import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { Settings } from "@threadterm/protocol";
import { desktopPreferences, testNotification } from "../bridge";
import { parseSupervision } from "../supervision";

const defaults = { showMainWindow: "CommandOrControl+Shift+Space", floatLastSession: "CommandOrControl+Shift+O" };
const displayKey = (value: string) => value.replace(/CommandOrControl/g, navigator.platform.includes("Mac") ? "Cmd" : "Ctrl");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
export function SettingsSwitch({ checked, onChange, disabled, children }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return <label className="setting-switch"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span />{children}</label>;
}
export function SettingsControls({ settings, zh, update, counts }: { settings: Settings; zh: boolean; update: (patch: Record<string, unknown>) => Promise<void>; counts: { checks: number; alertCount: number } }) {
  const keys = { ...defaults, ...record(settings.shortcuts) } as typeof defaults;
  const note = record(settings.notifications), config = parseSupervision(settings.supervision);
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string>(), [receipt, setReceipt] = useState<string>(), [preview, setPreview] = useState(false);
  const text = (cn: string, en: string) => zh ? cn : en;
  const run = (action: () => Promise<void>) => { if (busy) return; setBusy(true); setIssue(undefined); void action().catch(error => setIssue(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false)); };
  const save = (patch: Record<string, unknown>) => run(() => update(patch));
  const saveKey = (id: keyof typeof defaults, value: string) => run(async () => {
    const normalized = value.toLowerCase().replace("commandorcontrol", "ctrl");
    if (["ctrl+k", "ctrl+alt+n", "ctrl+s"].includes(normalized) || Object.entries(keys).some(([key, assigned]) => key !== id && assigned.toLowerCase() === value.toLowerCase())) throw new Error(text("此组合键已被占用，请选择其他组合。", "This combination is already assigned. Choose another shortcut."));
    await update({ shortcuts: { ...keys, [id]: value } });
    const result = await desktopPreferences();
    if (result.shortcuts[id] !== "registered") {
      await update({ shortcuts: keys });
      await desktopPreferences();
      throw new Error(text("系统未能注册此快捷键，已恢复原来的组合。", "The shortcut could not be registered. The previous combination was restored."));
    }
    setReceipt(text("快捷键已保存。", "Shortcut saved."));
  });
  const capture = (event: KeyboardEvent<HTMLInputElement>, id: keyof typeof defaults) => {
    if (["Tab", "Shift", "Control", "Alt", "Meta", "Escape"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
    const key = event.code === "Space" ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
    saveKey(id, [event.ctrlKey || event.metaKey ? "CommandOrControl" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", key].filter(Boolean).join("+"));
  };
  return <>
    <h3>{text("快捷键与提醒", "Shortcuts & attention")}</h3>
    <p>{text("录入组合键后会检查冲突；注册失败时保留已有快捷键。", "New combinations are checked for conflicts; an unavailable shortcut keeps its previous assignment.")}</p>
    {([['showMainWindow', text('命令面板', 'Command palette')], ['floatLastSession', text('浮窗', 'Floating window')]] as const).map(([id, label]) => <label key={id} className="shortcut-row"><span>{label}</span><input aria-label={label} disabled={busy} readOnly value={displayKey(keys[id])} onKeyDown={event => capture(event, id)} onFocus={event => event.currentTarget.select()} /><em /></label>)}
    <div className="setting-divider" />
    {([['native', text('允许系统通知', 'Allow system notifications'), note.native === true], ['attention', text('提及和需要批准', 'Mentions and approvals'), note.attention !== false], ['completed', text('任务完成', 'Completed tasks'), note.completed !== false], ['sound', text('播放提示音', 'Play a sound'), note.sound === true]] as const).map(([key, label, checked]) => <SettingsSwitch key={key} disabled={busy} checked={checked} onChange={value => save({ notifications: { ...note, [key]: value } })}>{label}</SettingsSwitch>)}
    <button className="btn-subtle" onClick={() => setPreview(value => !value)}>{text("预览通知", "Preview notification")}</button>
    <button className="btn-subtle" disabled={busy} onClick={() => run(async () => { const result = await testNotification(); setReceipt(result.sent ? text("测试通知已发送到系统通知中心。", "Test notification sent to the system notification center.") : `${text("测试未发送", "Test not sent")}: ${result.reason ?? text("通知已关闭", "notifications are disabled")}`); })}>{text("发送测试", "Send test")}</button>
    {preview && <div className="settings-card" role="status"><div className="settings-card-title">ThreadTerm · {text("通知预览", "Notification preview")}</div><p>{text("会话需要你的批准。", "A session needs your approval.")}</p><button className="btn-subtle" onClick={() => setPreview(false)}>{text("关闭预览", "Close preview")}</button></div>}
    <div className="setting-divider" />
    <SettingsSwitch disabled={busy} checked={settings.lightweightMode === true} onChange={value => run(async () => { await update({ lightweightMode: value }); await desktopPreferences(); })}>{text("轻量模式", "Lightweight mode")}</SettingsSwitch>
    <p className="hint">{settings.lightweightMode === true ? text("轻量模式已启用：独立浮窗不可用，热键将在主窗口打开会话。", "Lightweight mode opens the session in the main window instead of a floating window.") : text("浮窗热键", "Floating window hotkey")} <kbd>{displayKey(keys.floatLastSession)}</kbd></p>
    <div className="setting-divider" />
    <SettingsSwitch disabled={busy} checked={config.enabled} onChange={enabled => save({ supervision: { ...config, enabled } })}>{text("默认启用监督", "Enable supervisor by default")}</SettingsSwitch>
    <label>{text("观察范围（分钟）", "Observation range (minutes)")}<input type="range" min="5" max="60" step="5" disabled={busy} value={config.rangeMinutes} onChange={event => save({ supervision: { ...config, rangeMinutes: Number(event.target.value) } })} /><output>{config.rangeMinutes}</output></label>
    <label>{text("连续停滞阈值", "Consecutive stall threshold")}<input type="number" min="1" max="8" disabled={busy} value={config.threshold} onChange={event => save({ supervision: { ...config, threshold: Math.max(1, Math.min(8, Number(event.target.value) || 1)) } })} /></label>
    <p className="hint">{text("本窗口每分钟检查会话输出。达到观察时长且连续检查无变化时提醒；不会自动回复或审批。", "This window checks session output every minute and reports repeated inactivity after the observation range. It never replies or approves automatically.")}</p>
    <div className="supervisor-launch-counts"><div className="setting-divider" /><p className="hint">{text("本次启动监督计数", "Supervisor counters for this launch")}: {counts.checks} {text("次检查", "checks")} · {counts.alertCount} {text("个警示", "alerts")}。{text("它们不会作为历史审计保存。", "They are not retained as historical audit data.")}</p></div>
    <div className="compatibility-settings"><div className="setting-divider" /><h4>{text("AI 补全兼容性", "AI completion compatibility")}</h4><SettingsSwitch disabled={busy} checked={record(settings.terminalCompatibility).aiCompletionHints === true} onChange={aiCompletionHints => save({ terminalCompatibility: { aiCompletionHints } })}>{text("启用补全兼容启发式", "Enable completion compatibility heuristic")}</SettingsSwitch><p className="hint">{text("控制终端补全的输入兼容策略，不启用监督或后台检查。", "Controls terminal completion input compatibility without enabling supervision or background checks.")}</p><div className="setting-divider" /><p className="hint" role="status">{receipt ?? text("尚未发送通知测试。", "No notification test sent.")}</p></div>
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </>;
}
