import { localeFromSettings } from "../i18n";
import { Select } from "./ui/Select";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderCapability, Session, Snapshot } from "@threadterm/protocol";
import { chooseDirectory, operationId, request, subscribeEvents } from "../bridge";
import { displayPath } from "../projectScope";
import { accountProviders, signInTerminal } from "./providerSettings";
import { agentName } from "../agents";
import {
  IDLE_PROVIDER_REFRESH,
  observeProviderRefresh,
  providerRefreshText,
  type ProviderRefreshHandle,
  type ProviderRefreshState,
} from "../providerRefresh";

type Props = {
  data: Snapshot;
  onCreated?: (session: Session) => void | Promise<void>;
  onRefreshed?: () => void | Promise<void>;
};

export function ProviderSettingsPanel({ data, onCreated, onRefreshed }: Props) {
  const [capabilities, setCapabilities] = useState<ProviderCapability[]>(data.providers);
  const [projectId, setProjectId] = useState(() => data.projects[0]?.id ?? "");
  const [busyProvider, setBusyProvider] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [issue, setIssue] = useState<string>();
  const [providerDetectionFailed, setProviderDetectionFailed] = useState(false);
  const [refreshState, setRefreshState] = useState<ProviderRefreshState>(IDLE_PROVIDER_REFRESH);
  const refreshSequence = useRef(0);
  const mounted = useRef(true);
  const previousSnapshotEmpty = useRef<boolean | undefined>(undefined);
  const lastAutoCheckedProviders = useRef<ProviderCapability[] | undefined>(undefined);
  const refreshHandle = useRef<ProviderRefreshHandle | undefined>(undefined);
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;
  const locale = localeFromSettings(data.settings);
  const copy = { ...(locale === "zh-CN" ? zh : en), ...providerRefreshText(locale) };
  const checking = refreshState.phase === "checking" || refreshState.phase === "timeout";

  /** The cached read used by the automatic empty-snapshot check; never the forced path. */
  const loadCached = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const next = await request("provider.list", {});
      if (mounted.current && sequence === refreshSequence.current) {
        setCapabilities(next);
        setProviderDetectionFailed(false);
      }
    } catch {
      if (mounted.current && sequence === refreshSequence.current) setProviderDetectionFailed(true);
    }
  }, []);

  // One tracker for the whole mount: the parent may re-render without restarting
  // the checking state.
  useEffect(() => {
    const handle = observeProviderRefresh(
      () => request("provider.refresh", {}),
      subscribeEvents,
      setRefreshState,
      { onOutcome: outcome => { if (outcome === "ok") void onRefreshedRef.current?.(); } },
    );
    refreshHandle.current = handle;
    return () => {
      if (refreshHandle.current === handle) refreshHandle.current = undefined;
      handle.dispose();
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; refreshSequence.current++; previousSnapshotEmpty.current = undefined; lastAutoCheckedProviders.current = undefined; };
  }, []);
  useEffect(() => {
    const empty = data.providers.length === 0;
    const wasEmpty = previousSnapshotEmpty.current;
    previousSnapshotEmpty.current = empty;
    if (!empty || wasEmpty !== empty) refreshSequence.current++;
    setCapabilities(data.providers);
    if (!empty) { setIssue(undefined); setProviderDetectionFailed(false); }
  }, [data.providers]);
  useEffect(() => {
    const empty = data.providers.length === 0;
    if (empty && lastAutoCheckedProviders.current !== data.providers) {
      lastAutoCheckedProviders.current = data.providers;
      void loadCached();
    } else if (!empty) {
      lastAutoCheckedProviders.current = data.providers;
    }
  }, [data.providers, loadCached]);
  useEffect(() => {
    if (refreshState.phase !== "updated") return;
    const timer = setTimeout(() => setRefreshState(current => current.phase === "updated" ? IDLE_PROVIDER_REFRESH : current), 4000);
    return () => clearTimeout(timer);
  }, [refreshState.phase]);
  useEffect(() => {
    if (projectId && !data.projects.some((project) => project.id === projectId)) {
      setProjectId(data.projects[0]?.id ?? "");
    }
  }, [data.projects, projectId]);

  const refresh = async () => {
    setIssue(undefined);
    try {
      await refreshHandle.current?.refresh();
    } catch (error) {
      if (mounted.current) setIssue(errorMessage(error, copy.runtimeUnavailable));
    }
  };

  const openSignIn = async (capability: ProviderCapability) => {
    const command = signInTerminal(capability);
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
        title: `${agentName(capability.id, capabilities)} ${copy.signIn}`,
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
    <div className="settings-card-row"><div><div className="settings-card-title" id="provider-settings-title">{copy.title}</div><p>{copy.managed}</p></div><button className="btn btn-sm" type="button" aria-busy={checking} onClick={() => void refresh()} disabled={Boolean(busyProvider) || checking}>{checking ? copy.checking : copy.refresh}</button></div>
    <label>{copy.folder} <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
      <option value="">{copy.chooseFolder}</option>
      {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name} — {displayPath(project.path)}</option>)}
    </Select></label>
    {capabilities.length === 0 && !providerDetectionFailed && <p role="status" aria-live="polite">{copy.detecting}</p>}
    {providerDetectionFailed && <p className="surface-error" role="alert">{copy.detectionFailed}</p>}
    {refreshState.phase === "updated" && <p role="status" aria-live="polite">{copy.updated}</p>}
    {refreshState.phase === "failed" && <p role="status" aria-live="polite">{copy.failed}</p>}
    {refreshState.phase === "timeout" && <p role="status" aria-live="polite">{copy.timeout}</p>}
    <div className="settings-table" role="list" aria-label={copy.statusLabel}>
      {accountProviders(capabilities).map((capability) => {
        const command = signInTerminal(capability);
        const canOpen = Boolean(command && capability.installed && !busyProvider);
        return <article key={capability.id} role="listitem" className="tool-row">
          <div><strong>{capability.name}</strong><p>{capability.installed ? `${copy.installed}${capability.version ? ` · ${capability.version}` : ""}` : copy.notInstalled} · {copy.authentication}: {capability.auth ?? copy.unknown}</p>
            <p>{copy.terminal}: {yesNo(capability.terminal, copy)} · {copy.chat}: {yesNo(capability.chat, copy)} · {copy.history}: {yesNo(capability.history, copy)} · {copy.resume}: {yesNo(capability.resume, copy)}</p>
            {capability.reason && <p>{capability.reason}</p>}</div>
          {command && <button className="btn btn-sm" type="button" onClick={() => void openSignIn(capability)} disabled={!canOpen}>{busyProvider === capability.id ? copy.opening : copy.open}</button>}
        </article>;
      })}
    </div>
    {message && <p role="status" aria-live="polite">{message}</p>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </section>;
}

type Copy = typeof en;
const en = { title: "Provider accounts", signIn: "sign-in", managed: "Authentication and status are managed by each provider CLI.", folder: "Terminal folder", chooseFolder: "Choose a folder when opening a sign-in terminal", statusLabel: "Provider account status", detecting: "Detecting providers…", installed: "Installed", notInstalled: "Not installed", authentication: "authentication", unknown: "unknown", terminal: "Terminal", chat: "Chat", history: "History", resume: "Resume", available: "available", unavailable: "unavailable", open: "Open sign-in terminal", opening: "Opening…", created: (name: string) => `${name} sign-in terminal created. Complete sign-in in that terminal, then refresh status.`, runtimeUnavailable: "The runtime could not complete this provider action." };
const zh: Copy = { title: "提供商账户", signIn: "登录", managed: "认证和状态由各提供商 CLI 管理。", folder: "终端文件夹", chooseFolder: "打开登录终端时选择文件夹", statusLabel: "提供商账户状态", detecting: "正在检测提供商…", installed: "已安装", notInstalled: "未安装", authentication: "认证", unknown: "未知", terminal: "终端", chat: "聊天", history: "历史", resume: "恢复", available: "可用", unavailable: "不可用", open: "打开登录终端", opening: "正在打开…", created: (name: string) => `已创建 ${name} 登录终端。请在该终端中完成登录，然后刷新状态。`, runtimeUnavailable: "运行时无法完成此提供商操作。" };
function yesNo(value: boolean, copy: Copy): string { return value ? copy.available : copy.unavailable; }
function errorMessage(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
