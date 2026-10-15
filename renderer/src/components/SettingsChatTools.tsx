import { useId, useRef, useState } from "react";
import type { Settings } from "@threadterm/protocol";
import { SettingsSwitch } from "./SettingsControls";
import "./settings-chat-tools.css";

type Props = { settings: Settings; zh: boolean; update: (patch: Record<string, unknown>) => Promise<void> };

type ToolSpec = {
  id: string;
  en: string;
  zh: string;
  description: string;
  descriptionZh: string;
  /** Off-tools are on unless explicitly false; opt-in tools are on only when true. */
  optIn?: boolean;
  read: (settings: Settings) => boolean;
  /** The patch that persists the selected `enabled` value. */
  patch: (enabled: boolean) => Record<string, unknown>;
  testId?: string;
};

const flatTool = (id: string, en: string, zh: string, description: string, descriptionZh: string): ToolSpec => ({
  id, en, zh, description, descriptionZh,
  read: settings => (settings as Record<string, unknown>)[id] !== false,
  patch: enabled => ({ [id]: enabled }),
});

const tools: ToolSpec[] = [
  flatTool("chatTools.ask", "Ask", "提问", "Ask you a question with selectable answers.", "向你提问，并提供可选答案。"),
  flatTool("chatTools.sessionInfo", "Session info", "会话信息", "Read a referenced session and its recent conversation.", "读取你引用的会话信息和近期对话。"),
  flatTool("chatTools.feedback", "Feedback", "反馈", "Check for your notes between steps of a long task.", "在长任务的步骤之间查看你发送的反馈。"),
  flatTool("chatTools.delegation", "Delegation", "任务委派", "Delegate a task to another supported agent.", "将任务委派给其他受支持的智能体。"),
  {
    id: "chatTools.generatedUi",
    en: "Generated UI",
    zh: "生成式界面",
    description: "Teach supported agents to produce cards and charts in future chats. Existing blocks always render.",
    descriptionZh: "在后续对话中引导支持的代理生成卡片和图表。已有内容始终可以显示。",
    optIn: true,
    read: settings => (settings as { chatTools?: { generatedUi?: unknown } }).chatTools?.generatedUi === true,
    patch: enabled => ({ chatTools: { generatedUi: enabled } }),
    testId: "generated-ui-switch",
  },
];

export function SettingsChatTools({ settings, zh, update }: Props) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const saving = useRef(false);
  const progressId = useId();
  const activeTool = tools.find(tool => tool.id === busy);
  const toggle = async (tool: ToolSpec, enabled: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(tool.id); setError(undefined);
    try { await update(tool.patch(enabled)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : zh ? "无法保存工具设置。" : "Could not save tool settings."); }
    finally { saving.current = false; setBusy(undefined); }
  };
  return <section className="settings-chat-tools" aria-label={zh ? "会话内工具" : "In-conversation tools"} aria-busy={Boolean(busy)}>
    <h3>{zh ? "会话内工具" : "In-conversation tools"}</h3>
    <p>{zh ? "设置适用于之后连接的会话。" : "Applies to chats connected afterwards."}</p>
    {tools.map(tool => {
      const enabled = tool.read(settings);
      return <div className="settings-chat-tool-row" key={tool.id}>
        <span><b>{zh ? tool.zh : tool.en}</b><small>{zh ? tool.descriptionZh : tool.description}</small></span>
        <SettingsSwitch data-testid={tool.testId} aria-label={zh ? tool.zh : tool.en} aria-describedby={busy === tool.id ? progressId : undefined} checked={enabled} disabled={Boolean(busy)} onChange={value => void toggle(tool, value)}>
          {enabled ? zh ? "开启" : "On" : zh ? "关闭" : "Off"}
        </SettingsSwitch>
      </div>;
    })}
    {activeTool && <p id={progressId} role="status">{zh ? `正在保存${activeTool.zh}…` : `Saving ${activeTool.en}…`}</p>}
    {error && <p className="surface-error" role="alert">{error}</p>}
  </section>;
}
