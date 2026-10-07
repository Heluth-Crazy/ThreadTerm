import { memo, useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { ChatItem } from "@threadterm/protocol";
import { partBody, partLabel } from "../chatPresentation";
import { historyRenderablePart, historyToolStatus } from "../historyPresentation";
import { useTranslation } from "../i18n";
import { FileLinkedMarkdown } from "./FileReferenceText";
import "./history-transcript.css";

type Props = { items: ChatItem[]; compact?: boolean; empty?: string };

const HistoryMessage = memo(function HistoryMessage({ item, zh }: { item: ChatItem; zh: boolean }) {
  const copy = (en: string, cn: string) => zh ? cn : en;
  const parts = useMemo(() => item.parts.filter(historyRenderablePart).map(part => {
    const body = partBody(part);
    const parsed = item.role === "assistant" && part.type === "text" ? marked.parse(body, { gfm: true, breaks: true, async: false }) : undefined;
    const html = parsed === undefined ? undefined : DOMPurify.sanitize(parsed, {
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "base", "svg", "math", "audio", "video", "source", "track"],
      FORBID_ATTR: ["style", "srcset", "background", "poster", "data-threadterm-file-reference"],
      SANITIZE_NAMED_PROPS: true,
    });
    return { part, body, html };
  }), [item]);
  if (!parts.length) return null;
  return <article className={`history-transcript-item history-message-${item.role}`} data-role={item.role}>
    {parts.map(({ part, body, html }, index) => {
      if (part.type === "thinking") return <details className="history-transcript-thinking" key={index}>
        <summary>{copy("Thinking", "思考")}</summary><div className="history-message-plain">{body}</div>
      </details>;
      if (part.type === "tool") {
        const summary = <>{partLabel(part, copy)}<span className="history-tool-status">{historyToolStatus(part.status, copy)}</span></>;
        return body ? <details className="history-transcript-tool" key={index}><summary>{summary}</summary><pre>{body}</pre></details>
          : <div className="history-tool-line" key={index}>{summary}</div>;
      }
      if (part.type === "approval") return <details className="history-transcript-tool" key={index}><summary>{copy("Recorded approval", "已记录的批准请求")}</summary><pre>{body}</pre></details>;
      if (html !== undefined) return <FileLinkedMarkdown key={index} sanitizedHtml={html} />;
      return <div key={index} className={`history-message-plain${part.type === "error" ? " history-message-error" : ""}`}>{body}</div>;
    })}
  </article>;
});

/** Read-only presentation: no provider, control lease, or lifecycle effects. */
export function HistoryTranscript({ items, compact = false, empty }: Props) {
  const { locale } = useTranslation();
  const zh = locale === "zh-CN";
  return <div className={`history-transcript${compact ? " history-transcript-compact" : ""}`}>
    {items.some(item => item.parts.some(historyRenderablePart)) ? items.map(item => <HistoryMessage key={item.id} item={item} zh={zh} />)
      : <p className="history-transcript-empty">{empty ?? (zh ? "暂无消息" : "No messages yet")}</p>}
  </div>;
}
