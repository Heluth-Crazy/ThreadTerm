import { Select } from "./ui/Select";
import { useEffect, useState } from "react";
import type { ProviderCapability, ProviderId, Session } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { acquireControl } from "../controlLease";
import { useTranslation } from "../i18n";
import { buildExplainPrompt, isExplainProvider, MAX_EXPLAIN_SELECTION } from "./explainSelection";
import "./block-inspector.css";

type Props = { sessionId: string; text: string; onClose: () => void };

export function BlockInspector({ sessionId, text, onClose }: Props) {
  const { locale } = useTranslation();
  const zh = locale === "zh-CN";
  const copy = (en: string, cn: string) => (zh ? cn : en);
  const [session, setSession] = useState<Session>();
  const [providers, setProviders] = useState<ProviderCapability[]>([]);
  const [provider, setProvider] = useState<ProviderId>();
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string>();
  const [createdSessionId, setCreatedSessionId] = useState<string>();
  const shownText = text.length > MAX_EXPLAIN_SELECTION ? `${text.slice(0, MAX_EXPLAIN_SELECTION)}\n…` : text;
  const lineCount = text ? text.split(/\r?\n/).length : 0;
  const eligible = providers.filter(isExplainProvider);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([request("runtime.snapshot", {}), request("provider.list", {})])
      .then(([snapshot, capabilityList]) => {
        if (cancelled) return;
        const source = snapshot.sessions.find((item) => item.id === sessionId);
        if (!source) throw new Error(copy("The source terminal is no longer available.", "源终端已不可用。"));
        const chatProviders = capabilityList.filter(isExplainProvider);
        setSession(source);
        setProviders(capabilityList);
        setProvider((current) => current && chatProviders.some((item) => item.id === current) ? current : chatProviders[0]?.id);
      })
      .catch((error) => !cancelled && setIssue(error instanceof Error ? error.message : copy("Inspector data is unavailable.", "检查器数据不可用。")));
    return () => { cancelled = true; };
  }, [sessionId]);

  const explain = async () => {
    if (!session || !provider || busy) return;
    setBusy(true);
    setIssue(undefined);
    let created: Session | undefined;
    let release: (() => void) | undefined;
    try {
      const prompt = buildExplainPrompt(text);
      const cwd = session.worktreePath;
      if (!cwd) throw new Error(copy("The source session has no working directory.", "源会话没有工作目录。"));
      created = await request("session.create", {
        cwd,
        projectId: session.projectId,
        title: copy(`Explain terminal selection: ${session.title}`, `解释终端选区：${session.title}`),
        provider,
        mode: "chat",
        operationId: operationId(),
      });
      setCreatedSessionId(created.id);
      const control = await acquireControl(created.id, () => setIssue(copy("Chat control expired before the explanation was sent.", "解释发送前聊天控制已过期。")));
      release = control.release;
      await request("chat.connect", { sessionId: created.id, operationId: operationId(), leaseEpoch: control.epoch });
      await request("chat.send", { sessionId: created.id, text: prompt, operationId: operationId(), leaseEpoch: control.epoch });
      await request("session.present", {
        sessionId: created.id,
        placement: "workspace",
        presentation: "focused",
        workspacePath: session.worktreePath,
        operationId: operationId(),
      });
      onClose();
    } catch (error) {
      const detail = error instanceof Error ? error.message : copy("The explanation chat could not be started.", "无法启动解释聊天。");
      setIssue(created ? `${detail} ${copy("Created chat session:", "已创建聊天会话：")} ${created.id}` : detail);
    } finally {
      release?.();
      setBusy(false);
    }
  };

  return <section className="block-inspector" role="dialog" aria-modal="true" aria-label={copy("Terminal selection inspector", "终端选区检查器")}>
    <div className="block-inspector-heading"><div><h2>{copy("Terminal selection", "终端选区")}</h2><p>{lineCount} {copy("line(s), read only", "行，只读")}</p></div><button onClick={onClose} aria-label={copy("Close inspector", "关闭检查器")}>×</button></div>
    <pre className="block-inspector-text" tabIndex={0}>{shownText || copy("No text was selected.", "未选择文本。")}</pre>
    <div className="block-inspector-explain">
      <label>{copy("Explain in new Chat", "在新聊天中解释")}<Select value={provider ?? ""} onChange={(event) => setProvider(event.target.value as ProviderId)} disabled={busy || !eligible.length}><option value="">{copy("Choose a provider", "选择提供方")}</option>{eligible.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      {!eligible.length && <p>{copy("No installed, authenticated provider can start structured Chat.", "没有已安装且已认证的提供方可启动结构化聊天。")}</p>}
      <button className="primary" onClick={() => void explain()} disabled={busy || !session || !provider || !text.trim()}>{busy ? copy("Starting chat…", "正在启动聊天…") : copy("Explain in new Chat", "在新聊天中解释")}</button>
    </div>
    {createdSessionId && <p className="block-inspector-created">{copy("Created chat session:", "已创建聊天会话：")} <code>{createdSessionId}</code></p>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </section>;
}
