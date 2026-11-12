import { useEffect, useState } from "react";
import type { Settings } from "@threadterm/protocol";
import { terminalHostInfo } from "../terminalHost";
import { Select } from "./ui/Select";

export function SettingsTerminal({ settings, zh, update }: { settings: Settings; zh: boolean; update: (patch: Record<string, unknown>) => Promise<void> }) {
  const [pwshAvailable, setPwshAvailable] = useState<boolean>();
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string>();
  useEffect(() => {
    let live = true;
    void terminalHostInfo().then(info => { if (live) setPwshAvailable(info?.pwshAvailable === true); });
    return () => { live = false; };
  }, []);
  const selected = settings.defaultShell === "powershell" || settings.defaultShell === "pwsh" ? settings.defaultShell : "cmd";
  const save = async (value: string) => {
    setBusy(true); setIssue(undefined);
    try { await update({ defaultShell: value }); }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section className="settings-card settings-section settings-terminal" aria-label={zh ? "终端" : "Terminal"}>
    <label className="shortcut-row default-shell-setting"><span>{zh ? "默认 Shell" : "Default shell"}</span><Select aria-label={zh ? "默认 Shell" : "Default shell"} value={selected} disabled={busy} onChange={event => void save(event.target.value)}>
      <option value="cmd">{zh ? "命令提示符" : "Command Prompt"}</option>
      <option value="powershell">Windows PowerShell</option>
      {(pwshAvailable || selected === "pwsh") && <option value="pwsh">PowerShell 7</option>}
    </Select></label>
    <p className="hint">{zh ? "用于新建 Shell 终端。已有终端保留原来的 Shell。" : "Used for new Shell terminals. Existing terminals keep their shell."}</p>
    {selected === "pwsh" && pwshAvailable === false && <p className="hint" role="status">{zh ? "未找到 PowerShell 7，将使用 Windows PowerShell。" : "PowerShell 7 was not found. Using Windows PowerShell."}</p>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </section>;
}
