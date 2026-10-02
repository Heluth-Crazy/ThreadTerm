import { Select } from "./ui/Select";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderCapability, Session, Snapshot } from "@threadterm/protocol";
import { chooseDirectory, operationId, request } from "../bridge";
import { displayPath } from "../projectScope";
import { accountProviders, signInTerminal } from "./providerSettings";

type Props = {
  data: Snapshot;
  onCreated?: (session: Session) => void | Promise<void>;
};

export function ProviderSettingsPanel({ data, onCreated }: Props) {
  const [capabilities, setCapabilities] = useState<ProviderCapability[]>(data.providers);
  const [projectId, setProjectId] = useState(() => data.projects[0]?.id ?? "");
  const [busyProvider, setBusyProvider] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [issue, setIssue] = useState<string>();
  const refreshSequence = useRef(0);
  const copy = data.settings.language === "zh-CN" ? zh : en;

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setIssue(undefined);
    try {
      const next = await request("provider.list", {});
      if (sequence === refreshSequence.current) setCapabilities(next);
    } catch (error) {
      if (sequence === refreshSequence.current) setIssue(errorMessage(error, copy.runtimeUnavailable));
    }
  }, [copy.runtimeUnavailable]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (projectId && !data.projects.some((project) => project.id === projectId)) {
      setProjectId(data.projects[0]?.id ?? "");
    }
  }, [data.projects, projectId]);

  const openSignIn = async (capability: ProviderCapability) => {
    const command = signInTerminal(capability.id);
    if (!command || !capability.installed) return;
    setBusyProvider(capability.id);
    setIssue(undefined);
    setMessage(undefined);
    try {
      const project = data.projects.find((item) => item.id === projectId);
      const cwd = project?.path ?? await chooseDirectory();
      if (!cwd) return;
      const session = await request("session.create", {
        cwd,
        projectId: project?.id,
        title: `${capability.name} sign-in`,
        provider: command.provider,
        mode: "terminal",
        executable: command.executable,
        args: [...command.args],
        operationId: operationId(),
      });
      await onCreated?.(session);
      setMessage(copy.created(capability.name));
    } catch (error) {
      setIssue(errorMessage(error, copy.runtimeUnavailable));
    } finally {
      setBusyProvider(undefined);
    }
  };

  return <section className="settings-card provider-settings" aria-labelledby="provider-settings-title">
    <div className="settings-card-row"><div><div className="settings-card-title" id="provider-settings-title">{copy.title}</div><p>{copy.managed}</p></div><button className="btn-subtle" type="button" onClick={() => void refresh()} disabled={Boolean(busyProvider)}>{copy.refresh}</button></div>
    <label>{copy.folder} <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
      <option value="">{copy.chooseFolder}</option>
      {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name} — {displayPath(project.path)}</option>)}
    </Select></label>
    <div className="settings-table" role="list" aria-label={copy.statusLabel}>
      {accountProviders(capabilities).map((capability) => {
        const command = signInTerminal(capability.id);
        const canOpen = Boolean(command && capability.installed && !busyProvider);
        return <article key={capability.id} role="listitem" className="tool-row">
          <div><strong>{capability.name}</strong><p>{capability.installed ? `${copy.installed}${capability.version ? ` · ${capability.version}` : ""}` : copy.notInstalled} · {copy.authentication}: {capability.auth ?? copy.unknown}</p>
            <p>{copy.terminal}: {yesNo(capability.terminal, copy)} · {copy.chat}: {yesNo(capability.chat, copy)} · {copy.history}: {yesNo(capability.history, copy)} · {copy.resume}: {yesNo(capability.resume, copy)}</p>
            {capability.reason && <p>{capability.reason}</p>}</div>
          {command && <button className="btn-subtle" type="button" onClick={() => void openSignIn(capability)} disabled={!canOpen}>{busyProvider === capability.id ? copy.opening : copy.open}</button>}
        </article>;
      })}
    </div>
    {message && <p role="status" aria-live="polite">{message}</p>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </section>;
}

type Copy = typeof en;
const en = { title: "Provider accounts", managed: "Authentication and status are managed by each provider CLI.", folder: "Terminal folder", chooseFolder: "Choose a folder when opening a sign-in terminal", refresh: "Refresh provider status", statusLabel: "Provider account status", installed: "Installed", notInstalled: "Not installed", authentication: "authentication", unknown: "unknown", terminal: "Terminal", chat: "Chat", history: "History", resume: "Resume", available: "available", unavailable: "unavailable", open: "Open sign-in terminal", opening: "Opening…", created: (name: string) => `${name} sign-in terminal created. Complete sign-in in that terminal, then refresh status.`, runtimeUnavailable: "The runtime could not complete this provider action." };
const zh: Copy = { title: "提供商账户", managed: "认证和状态由各提供商 CLI 管理。", folder: "终端文件夹", chooseFolder: "打开登录终端时选择文件夹", refresh: "刷新提供商状态", statusLabel: "提供商账户状态", installed: "已安装", notInstalled: "未安装", authentication: "认证", unknown: "未知", terminal: "终端", chat: "聊天", history: "历史", resume: "恢复", available: "可用", unavailable: "不可用", open: "打开登录终端", opening: "正在打开…", created: (name: string) => `已创建 ${name} 登录终端。请在该终端中完成登录，然后刷新状态。`, runtimeUnavailable: "运行时无法完成此提供商操作。" };
function yesNo(value: boolean, copy: Copy): string { return value ? copy.available : copy.unavailable; }
function errorMessage(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
