import { useEffect, useState } from "react";
import type { ChatItem, Session } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { useTranslation } from "../i18n";
import { HistoryTranscript } from "./HistoryTranscript";
import "./history-rail.css";

type Props = { session: Session; onResumed?: (session: Session) => void };

/** A durable provider-history projection. It never mounts an interactive host. */
export function ImportedHistoryView({ session, onResumed }: Props) {
  const { locale } = useTranslation();
  const zh = locale === "zh-CN";
  const copy = (en: string, cn: string) => zh ? cn : en;
  const [items, setItems] = useState<ChatItem[]>();
  const [issue, setIssue] = useState<string>();
  const [resuming, setResuming] = useState(false);
  useEffect(() => {
    let current = true;
    setItems(undefined); setIssue(undefined);
    void request("chat.snapshot", { sessionId: session.id })
      .then(result => { if (current) setItems(result.items); })
      .catch(error => { if (current) setIssue(error instanceof Error ? error.message : copy("Saved history could not be read.", "无法读取已保存的历史。")); });
    return () => { current = false; };
  }, [session.id, locale]);
  const resume = async () => {
    setResuming(true); setIssue(undefined);
    try {
      const resumed = await request("session.resume", { sessionId: session.id, cwd: session.worktreePath, operationId: operationId() });
      onResumed?.(resumed);
    } catch (error) { setIssue(error instanceof Error ? error.message : copy("The session could not be resumed.", "无法恢复会话。")); }
    finally { setResuming(false); }
  };
  return <section className="imported-history-view" aria-label={copy("Imported history", "已导入历史")}>
    <header><div><strong>{session.title || copy("Imported history", "已导入历史")}</strong><small>{copy("Read-only until you explicitly resume it.", "在显式恢复前仅可读取。")}</small></div>{session.readOnly && <button className="btn btn-primary" onClick={() => void resume()} disabled={resuming}>{copy("Resume explicitly", "显式恢复")}</button>}</header>
    {issue && <p className="surface-error" role="alert">{issue}</p>}
    <div className="imported-history-scroll">
      {!items && !issue && <p className="history-transcript-empty">{copy("Loading saved transcript…", "正在加载已保存的记录…")}</p>}
      {items && <HistoryTranscript items={items} empty={copy("This provider returned no structured transcript.", "该提供方未返回结构化记录。")} />}
    </div>
  </section>;
}
