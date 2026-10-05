import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Settings } from "@threadterm/protocol";
import { desktopPreferences, testNotification } from "../bridge";
import { parseSupervision, type SupervisionSettings } from "../supervision";
import { createLatestValueQueue } from "../latestValueQueue";
import { selectedConptyHost, terminalHostInfo, type ConptyHost, type TerminalHostInfo } from "../terminalHost";

const defaults = { showMainWindow: "CommandOrControl+Shift+Space", floatLastSession: "CommandOrControl+Shift+O" };
const displayKey = (value: string) => value.replace(/CommandOrControl/g, navigator.platform.includes("Mac") ? "Cmd" : "Ctrl");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
export function SettingsSwitch({ checked, onChange, disabled, children }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return <label className="setting-switch"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span />{children}</label>;
}
export function SettingsControls({ settings, zh, update, counts }: { settings: Settings; zh: boolean; update: (patch: Record<string, unknown>) => Promise<void>; counts: { checks: number; alertCount: number } }) {
  const keys = { ...defaults, ...record(settings.shortcuts) } as typeof defaults;
  const note = record(settings.notifications), config = parseSupervision(settings.supervision);
  const [runBusy, setBusy] = useState(false), [issue, setIssue] = useState<string>(), [receipt, setReceipt] = useState<string>(), [testReceipt, setTestReceipt] = useState<string>();
  // The threshold draft may be "" while the field is cleared to type a new digit; leaving it empty restores the saved value.
  const [draft, setDraft] = useState<{ rangeMinutes: number; threshold: number | "" }>({ rangeMinutes: config.rangeMinutes, threshold: config.threshold }), [editing, setEditing] = useState({ rangeMinutes: false, threshold: false });
  const [supervisionSaving, setSupervisionSaving] = useState(false), [savedVersion, setSavedVersion] = useState(0);
  const busy = runBusy || supervisionSaving;
  const queue = useRef(createLatestValueQueue<Pick<SupervisionSettings, "rangeMinutes" | "threshold">>()), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef({ config, update, runBusy }); current.current = { config, update, runBusy };
  const flush = () => {
    if (timer.current !== undefined) { clearTimeout(timer.current); timer.current = undefined; }
    if (current.current.runBusy) return;
    const patch = queue.current.take(); if (!patch) return;
    setSupervisionSaving(true); setIssue(undefined);
    void current.current.update({ supervision: { ...current.current.config, ...patch } }).then(() => { current.current.config = { ...current.current.config, ...patch }; }).catch(error => setIssue(error instanceof Error ? error.message : String(error))).finally(() => {
      queue.current.finish(); setSupervisionSaving(false); setSavedVersion(value => value + 1); flushRef.current();
    });
  };
  const flushRef = useRef(flush); flushRef.current = flush;
  const changeSupervision = (key: "rangeMinutes" | "threshold", value: number) => {
    setDraft(previous => ({ ...previous, [key]: value })); queue.current.stage({ [key]: value });
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = undefined; flushRef.current(); }, 400);
  };
  useEffect(() => {
    setDraft(previous => ({ rangeMinutes: editing.rangeMinutes || queue.current.has("rangeMinutes") ? previous.rangeMinutes : config.rangeMinutes, threshold: editing.threshold || queue.current.has("threshold") ? previous.threshold : config.threshold }));
  }, [config.rangeMinutes, config.threshold, editing, savedVersion]);
  useEffect(() => { if (!runBusy) flushRef.current(); }, [runBusy]);
  useEffect(() => () => { flushRef.current(); }, []);
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
    {receipt && <p className="hint" role="status">{receipt}</p>}
    <div className="setting-divider" />
    {([['native', text('允许系统通知', 'Allow system notifications'), note.native === true], ['attention', text('需要你处理（批准、等待、失败）', 'Needs your attention (approvals, waiting, failures)'), note.attention !== false], ['completed', text('完成（回复、终端结束）', 'Finished (replies, ended terminals)'), note.completed !== false], ['sound', text('播放提示音', 'Play a sound'), note.sound === true]] as const).map(([key, label, checked]) => <SettingsSwitch key={key} disabled={busy || (key !== 'native' && note.native !== true)} checked={checked} onChange={value => save({ notifications: { ...note, [key]: value } })}>{label}</SettingsSwitch>)}
    <p className="hint">{text("ThreadTerm 在后台时显示；点击通知会打开对应会话。你在 ThreadTerm 里时，由待处理和应用内提醒告诉你。", "Shown while ThreadTerm is in the background; click one to open its session. While you are in ThreadTerm, the inbox and in-app banners tell you instead.")}</p>
    <button className="btn-subtle" disabled={busy} onClick={() => run(async () => { const result = await testNotification(); setTestReceipt(result.sent ? text("测试通知已发送。没有看到的话，请在 Windows 设置 → 系统 → 通知 中允许 ThreadTerm。", "Test notification sent. If it didn't appear, allow ThreadTerm in Windows Settings → System → Notifications.") : `${text("测试未发送", "Test not sent")}: ${result.reason ?? text("通知已关闭", "notifications are off")}`); })}>{text("发送测试通知", "Send test notification")}</button>
    {testReceipt && <p className="hint" role="status">{testReceipt}</p>}
    <div className="setting-divider" />
    <SettingsSwitch disabled={busy} checked={settings.lightweightMode === true} onChange={value => run(async () => { await update({ lightweightMode: value }); await desktopPreferences(); })}>{text("轻量模式", "Lightweight mode")}</SettingsSwitch>
    <p className="hint">{settings.lightweightMode === true ? text("轻量模式已启用：独立浮窗不可用，热键将在主窗口打开会话。", "Lightweight mode opens the session in the main window instead of a floating window.") : text("浮窗热键", "Floating window hotkey")} <kbd>{displayKey(keys.floatLastSession)}</kbd></p>
    <div className="setting-divider" />
    <SettingsSwitch disabled={busy} checked={config.enabled} onChange={enabled => save({ supervision: { ...config, enabled } })}>{text("默认启用监督", "Enable supervisor by default")}</SettingsSwitch>
    <label>{text("观察范围（分钟）", "Observation range (minutes)")}<input type="range" min="5" max="60" step="5" value={draft.rangeMinutes} onFocus={() => setEditing(previous => ({ ...previous, rangeMinutes: true }))} onChange={event => changeSupervision("rangeMinutes", Number(event.target.value))} onBlur={() => { setEditing(previous => ({ ...previous, rangeMinutes: false })); flush(); }} onPointerUp={flush} onKeyDown={event => { if (event.key === "Enter") flush(); }} /><output>{draft.rangeMinutes}</output></label>
    <label>{text("连续停滞阈值", "Consecutive stall threshold")}<input type="number" min="1" max="8" value={draft.threshold} onFocus={() => setEditing(previous => ({ ...previous, threshold: true }))} onChange={event => { if (event.target.value === "") setDraft(previous => ({ ...previous, threshold: "" })); else changeSupervision("threshold", Math.max(1, Math.min(8, Number(event.target.value) || 1))); }} onBlur={() => { setEditing(previous => ({ ...previous, threshold: false })); flush(); }} onPointerUp={flush} onKeyDown={event => { if (event.key === "Enter") flush(); }} /></label>
    <p className="hint">{text("本窗口每分钟检查会话输出。达到观察时长且连续检查无变化时提醒；不会自动回复或审批。", "This window checks session output every minute and reports repeated inactivity after the observation range. It never replies or approves automatically.")}</p>
    <div className="supervisor-launch-counts"><div className="setting-divider" /><p className="hint">{text("本次启动监督计数", "Supervisor counters for this launch")}: {counts.checks} {text("次检查", "checks")} · {counts.alertCount} {text("个警示", "alerts")}。{text("它们不会作为历史审计保存。", "They are not retained as historical audit data.")}</p></div>
    <div className="compatibility-settings"><div className="setting-divider" /><h4>{text("AI 补全兼容性", "AI completion compatibility")}</h4><SettingsSwitch disabled={busy} checked={record(settings.terminalCompatibility).aiCompletionHints === true} onChange={aiCompletionHints => save({ terminalCompatibility: { aiCompletionHints } })}>{text("启用补全兼容启发式", "Enable completion compatibility heuristic")}</SettingsSwitch><p className="hint">{text("控制终端补全的输入兼容策略，不启用监督或后台检查。", "Controls terminal completion input compatibility without enabling supervision or background checks.")}</p></div>
    {window.threadterm.windowsPty && <ConptyHostSetting selected={selectedConptyHost(settings.conptyHost)} disabled={busy} text={text} onChange={host => save({ conptyHost: host })} />}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </>;
}

/** Windows only: which console host terminals run on (runtime/src/conpty.rs); read when the runtime starts. */
function ConptyHostSetting({ selected, disabled, text, onChange }: { selected: ConptyHost; disabled: boolean; text: (cn: string, en: string) => string; onChange: (host: ConptyHost) => void }) {
  const [info, setInfo] = useState<TerminalHostInfo>();
  useEffect(() => {
    let live = true;
    void terminalHostInfo().then(value => { if (live) setInfo(value); });
    return () => { live = false; };
  }, []);
  const name = (host: ConptyHost) => host === "bundled" ? text("随附的 OpenConsole", "the bundled OpenConsole") : text("Windows 自带的控制台主机", "the Windows built-in console host");
  return <div className="compatibility-settings"><div className="setting-divider" />
    <h4>{text("终端控制台主机", "Terminal console host")}</h4>
    <SettingsSwitch disabled={disabled} checked={selected === "bundled"} onChange={value => onChange(value ? "bundled" : "system")}>{text("使用随附的 OpenConsole", "Use the bundled OpenConsole")}</SettingsSwitch>
    <p className="hint">{text("ThreadTerm 随附的 Microsoft OpenConsole 1.24 比旧版 Windows 自带的控制台主机更新：拖动分隔线后不会在回滚区留下重复画面，调整终端宽度时占满整行的文字也不会和下一行粘连。", "Microsoft's OpenConsole 1.24, shipped with ThreadTerm, is newer than the console host in older Windows: dragging a divider leaves no stray copies of the screen in the scrollback, and lines that fill the full width stay separate when a terminal is resized.")}</p>
    {info && <p className="hint">{text(`当前使用：${name(info.conptyHost)}。`, `In use: ${name(info.conptyHost)}.`)}{selected === "bundled" && !info.bundledAvailable
      ? text("此版本未附带 OpenConsole 文件。", " This build does not include the OpenConsole files.")
      : info.conptyHost !== selected && text("重新启动 ThreadTerm（包括后台运行时）后生效。", " Takes effect after ThreadTerm, including its background runtime, restarts.")}</p>}
  </div>;
}
