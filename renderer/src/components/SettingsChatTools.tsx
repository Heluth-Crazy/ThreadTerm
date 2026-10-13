import { useRef, useState } from "react";
import type { Settings } from "@threadterm/protocol";
import "./settings-chat-tools.css";

type Props = { settings: Settings; zh: boolean; update: (patch: Record<string, unknown>) => Promise<void> };
const tools = [
  { key: "chatTools.ask", en: "Ask", zh: "提问", description: "Ask you a question with selectable answers.", descriptionZh: "向你提问，并提供可选答案。" },
  { key: "chatTools.sessionInfo", en: "Session info", zh: "会话信息", description: "Read a referenced session and its recent conversation.", descriptionZh: "读取你引用的会话信息和近期对话。" },
  { key: "chatTools.feedback", en: "Feedback", zh: "反馈", description: "Check for your notes between steps of a long task.", descriptionZh: "在长任务的步骤之间查看你发送的反馈。" },
  { key: "chatTools.delegation", en: "Delegation", zh: "任务委派", description: "Delegate a task to another supported agent.", descriptionZh: "将任务委派给其他受支持的智能体。" },
] as const;

export function SettingsChatTools({ settings, zh, update }: Props) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const saving = useRef(false);
  const toggle = async (key: string, enabled: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(key); setError(undefined);
    try { await update({ [key]: !enabled }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : zh ? "无法保存工具设置。" : "Could not save tool settings."); }
    finally { saving.current = false; setBusy(undefined); }
  };
  return <section className="settings-chat-tools" aria-label={zh ? "会话内工具" : "In-conversation tools"} aria-busy={Boolean(busy)}>
    <h3>{zh ? "会话内工具" : "In-conversation tools"}</h3>
    <p>{zh ? "设置适用于之后连接的会话。" : "Applies to chats connected afterwards."}</p>
    {tools.map(tool => {
      const enabled = settings[tool.key] !== false;
      return <div className="settings-chat-tool-row" key={tool.key}>
        <span><b>{zh ? tool.zh : tool.en}</b><small>{zh ? tool.descriptionZh : tool.description}</small></span>
        <button type="button" className="btn btn-sm btn-ghost" role="switch" aria-checked={enabled} aria-label={zh ? tool.zh : tool.en} disabled={Boolean(busy)} onClick={() => void toggle(tool.key, enabled)}>
          {busy === tool.key ? zh ? "保存中…" : "Saving…" : enabled ? zh ? "开启" : "On" : zh ? "关闭" : "Off"}
        </button>
      </div>;
    })}
    {error && <p className="surface-error" role="alert">{error}</p>}
  </section>;
}
