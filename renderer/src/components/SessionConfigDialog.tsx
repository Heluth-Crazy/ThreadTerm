import { Icon } from "./PrototypeIcon";
import { Select } from "./ui/Select";
import { FormEvent, useEffect, useState } from "react";
import type { ProviderId, Session, SessionConfig, Snapshot } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { displayPath } from "../projectScope";
import { RetrySettings } from "./RetrySettings";
import { agentIds, agentName } from "../agents";
import { useTranslation } from "../i18n";

const isActive = (session: Session) =>
  !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status);

const configCopy = (zh: boolean) => zh ? {
  heading: "会话配置",
  mode: "模式",
  executable: "可执行文件",
  executablePlaceholder: "使用提供方默认值",
  arguments: "参数",
  argumentsPlaceholder: "每行一个参数",
  save: "保存配置",
  stopRerun: "停止后重新运行",
  rerun: "在新会话中重新运行",
  loading: "正在加载配置…",
  readError: "无法读取此会话配置。",
  saveError: "配置未保存。",
  rerunError: "无法重新运行此会话。",
  confirmStop: "结束此活动会话，并按其已保存的配置创建新会话？",
} : {
  heading: "Session configuration",
  mode: "Mode",
  executable: "Executable",
  executablePlaceholder: "Provider default",
  arguments: "Arguments",
  argumentsPlaceholder: "One argument per line",
  save: "Save configuration",
  stopRerun: "Stop then rerun",
  rerun: "Rerun in new session",
  loading: "Loading configuration…",
  readError: "Unable to read this session configuration.",
  saveError: "Configuration was not saved.",
  rerunError: "Unable to rerun this session.",
  confirmStop: "End this active session and create a new session from its saved configuration?",
};

export function SessionConfigDialog({
  session,
  data,
  onClose,
  onRerun,
}: {
  session: Session;
  data: Snapshot;
  onClose: () => void;
  onRerun: (id: string) => void;
}) {
  const { locale, t } = useTranslation();
  const text = configCopy(locale === "zh-CN");
  const providers = [...agentIds(data.providers), "shell", "custom"];
  const [config, setConfig] = useState<SessionConfig>();
  const [args, setArgs] = useState("");
  const [issue, setIssue] = useState<string>();
  const [fallback, setFallback] = useState<"readError" | "saveError" | "rerunError">();
  const [busy, setBusy] = useState(false);
  const shownIssue = issue ?? (fallback ? text[fallback] : undefined);
  useEffect(() => {
    void request("session.config.read", { sessionId: session.id })
      .then((value) => {
        setConfig(value);
        setArgs(value.args.join("\n"));
      })
      .catch((error) => {
        if (error instanceof Error) setIssue(error.message);
        else setFallback("readError");
      });
  }, [session.id]);
  const update = <K extends keyof SessionConfig>(
    key: K,
    value: SessionConfig[K],
  ) =>
    setConfig((current) => (current ? { ...current, [key]: value } : current));
  const save = async () => {
    if (!config) return false;
    setBusy(true);
    setIssue(undefined);
    setFallback(undefined);
    try {
      const saved = await request("session.config.save", {
        sessionId: session.id,
        provider: config.provider,
        mode: config.mode,
        cwd: config.cwd.trim(),
        projectId: config.projectId,
        title: config.title?.trim() || undefined,
        executable: config.executable?.trim() || undefined,
        args: args
          .split("\n")
          .map((arg) => arg.trim())
          .filter(Boolean),
        expectedRevision: config.revision,
        operationId: operationId(),
      });
      setConfig(saved);
      setArgs(saved.args.join("\n"));
      return true;
    } catch (error) {
      if (error instanceof Error) setIssue(error.message);
      else setFallback("saveError");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await save();
  };
  const rerun = async (stopFirst: boolean) => {
    if (isActive(session) && !stopFirst) return;
    if (
      stopFirst &&
      !confirm(text.confirmStop)
    )
      return;
    if (!(await save())) return;
    setBusy(true);
    try {
      if (stopFirst)
        await request("session.stop", {
          sessionId: session.id,
          operationId: operationId(),
        });
      const created = await request("session.rerun", {
        sessionId: session.id,
        operationId: operationId(),
      });
      onRerun(created.id);
    } catch (error) {
      if (error instanceof Error) setIssue(error.message);
      else setFallback("rerunError");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scrim" role="presentation">
      <section
        className="dialog session-config"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-config-title"
      >
        <div className="dialog-title">
          <span className="sheet-head-text"><h2 id="session-config-title">{text.heading}</h2><p title={session.title}>{session.title}</p></span>
          <button type="button" className="icon-btn" aria-label={t("close")} onClick={onClose}><Icon name="close" /></button>
        </div>
        {config ? (
          <form
            className="dialog-form"
            onSubmit={(event) => void submit(event)}
          >
            <label>
              {t("provider")}
              <Select
                value={config.provider}
                onChange={(event) =>
                  update("provider", event.target.value as ProviderId)
                }
              >
                {providers.map((provider) => (
                  <option key={provider} value={provider} disabled={Boolean(data.providers.find(item => item.id === provider && !item.installed))}>{agentName(provider, data.providers)}</option>
                ))}
              </Select>
            </label>
            <label>
              {text.mode}
              <Select
                value={config.mode}
                onChange={(event) =>
                  update("mode", event.target.value as SessionConfig["mode"])
                }
              >
                <option value="terminal">{t("terminal")}</option>
                <option value="chat">{t("structuredChat")}</option>
              </Select>
            </label>
            <label>
              {t("workingDirectory")}
              <input
                required
                value={displayPath(config.cwd)}
                onChange={(event) => update("cwd", event.target.value)}
              />
            </label>
            <label>
              {text.executable}{" "}
              <input
                value={config.executable ?? ""}
                onChange={(event) => update("executable", event.target.value)}
                placeholder={text.executablePlaceholder}
              />
            </label>
            <label>
              {text.arguments}{" "}
              <textarea
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                placeholder={text.argumentsPlaceholder}
                rows={4}
              />
            </label>
            <label>
              {t("title")}{" "}
              <input
                value={config.title ?? ""}
                onChange={(event) => update("title", event.target.value)}
              />
            </label>
            <RetrySettings sessionId={session.id} terminal={session.mode === "terminal"} />
            {shownIssue && (
              <p role="alert" className="surface-error">
                {shownIssue}
              </p>
            )}
            <div className="dialog-actions">
              <button className="btn btn-lg" type="button" onClick={onClose}>
                {t("cancel")}
              </button>
              <button className="btn btn-primary" disabled={busy} type="submit">
                {text.save}
              </button>
              {isActive(session) ? (
                <button
                  type="button"
                  className="btn btn-lg btn-danger"
                  disabled={busy}
                  onClick={() => void rerun(true)}
                >
                  {text.stopRerun}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-lg"
                  disabled={busy}
                  onClick={() => void rerun(false)}
                >
                  {text.rerun}
                </button>
              )}
            </div>
          </form>
        ) : (
          <p className="settings-note">{text.loading}</p>
        )}
      </section>
    </div>
  );
}
