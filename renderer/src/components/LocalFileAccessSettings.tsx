import { useEffect, useRef, useState } from "react";

type Backend = "runtime" | "main";
type LocalFilesBridge = {
  getBackend(): Promise<Backend>;
  setBackend(mode: Backend): Promise<Backend>;
  onBackendChanged?(listener: (mode: Backend) => void): () => void;
};

const copy = (zh: boolean, en: string, cn: string) => zh ? cn : en;

function localFilesBridge(): LocalFilesBridge | undefined {
  const bridge = (window.threadterm as typeof window.threadterm & { localFiles?: Partial<LocalFilesBridge>; machineId?: string });
  if (bridge.machineId && bridge.machineId !== "local") return undefined;
  const localFiles = bridge.localFiles;
  return localFiles && typeof localFiles.getBackend === "function" && typeof localFiles.setBackend === "function"
    ? localFiles as LocalFilesBridge
    : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Additive desktop-only setting. File operations remain behind the desktop bridge. */
export function LocalFileAccessSettings({ zh }: { zh: boolean }) {
  const bridge = localFilesBridge();
  const [backend, setBackend] = useState<Backend>();
  const [loading, setLoading] = useState(Boolean(bridge));
  const [saving, setSaving] = useState(false);
  const [issue, setIssue] = useState<string>();
  const revision = useRef(0);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const unsubscribe = bridge.onBackendChanged?.(mode => {
      revision.current += 1;
      if (live) {
        setBackend(mode);
        setIssue(undefined);
      }
    });
    const requestedAt = revision.current;
    void bridge.getBackend().then(mode => {
      if (live && revision.current === requestedAt) setBackend(mode);
    }).catch(error => {
      if (live) setIssue(errorMessage(error, copy(zh, "Could not read the local file access setting.", "无法读取本地文件访问设置。")));
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; unsubscribe?.(); };
  }, [bridge, zh]);

  if (!bridge) return null;
  const pending = loading || saving;
  const choose = (mode: Backend) => {
    if (pending || mode === backend) return;
    const requestedAt = revision.current;
    setSaving(true);
    setIssue(undefined);
    void bridge.setBackend(mode).then(selected => {
      if (revision.current === requestedAt) setBackend(selected);
    }).catch(error => {
      setIssue(errorMessage(error, copy(zh, "Could not change the local file access setting.", "无法更改本地文件访问设置。")));
    }).finally(() => setSaving(false));
  };
  const title = copy(zh, "Local file access", "本地文件访问");

  return <section className="local-file-access-settings" aria-labelledby="local-file-access-title">
    <div className="setting-divider" />
    <h4 id="local-file-access-title">{title}</h4>
    <p className="hint">{copy(zh, "Choose which desktop process accesses files on this PC. Remote files always follow their host computer.", "选择本机由哪个桌面进程访问文件。远程文件始终跟随其主机。")}</p>
    <fieldset disabled={pending || backend === undefined} aria-describedby="local-file-access-description">
      <legend className="sr-only">{title}</legend>
      <label className="local-file-access-option"><input type="radio" name="local-file-access" checked={backend === "runtime"} onChange={() => choose("runtime")} /><span><b>{copy(zh, "Background process", "后台进程")}</b><small>{copy(zh, "Default. Use the existing Runtime file service.", "默认。使用现有 Runtime 文件服务。")}</small></span></label>
      <label className="local-file-access-option"><input type="radio" name="local-file-access" checked={backend === "main"} onChange={() => choose("main")} /><span><b>{copy(zh, "Main process", "主进程")}</b><small>{copy(zh, "Compatibility option for this desktop app.", "此桌面应用的兼容性选项。")}</small></span></label>
    </fieldset>
    <p id="local-file-access-description" className="sr-only">{copy(zh, "Changing this setting does not change open editor drafts.", "更改此设置不会修改已打开编辑器中的草稿。")}</p>
    {pending && <p className="hint" role="status" aria-live="polite">{loading ? copy(zh, "Reading local file access setting…", "正在读取本地文件访问设置…") : copy(zh, "Changing local file access setting…", "正在更改本地文件访问设置…")}</p>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </section>;
}
