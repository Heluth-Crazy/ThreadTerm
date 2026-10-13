// Settings → Controls → Quick messages (task 10-11-chat-parity F3).
//
// Add, edit, delete and reorder the snippets the composer's `+` menu and
// right-click menu insert. The whole list is saved as one additive
// `quickMessages` setting; the runtime settings schema validates the bounds.
import { useState } from "react";
import type { Settings } from "@threadterm/protocol";
import { Icon } from "./PrototypeIcon";
import { MAX_QUICK_MESSAGE_TEXT, MAX_QUICK_MESSAGE_TITLE, MAX_QUICK_MESSAGES, createQuickMessageId, moveQuickMessage, parseQuickMessages, quickMessageLength } from "../quickMessages";
import "./settings-quick-messages.css";

type Draft = { id: string; title: string; text: string; isNew: boolean };

export function SettingsQuickMessages({ settings, zh, update }: { settings: Settings; zh: boolean; update: (patch: Record<string, unknown>) => Promise<void> }) {
  const messages = parseQuickMessages(settings.quickMessages);
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string>();
  const text = (cn: string, en: string) => zh ? cn : en;

  const save = (next: typeof messages) => {
    if (busy) return;
    setBusy(true); setIssue(undefined);
    void update({ quickMessages: next }).then(() => setDraft(undefined)).catch(error => setIssue(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
  };

  const commitDraft = () => {
    if (!draft) return;
    const title = draft.title.trim();
    const body = draft.text.trim();
    if (!title) { setIssue(text("请输入标题。", "Enter a title.")); return; }
    if (quickMessageLength(title) > MAX_QUICK_MESSAGE_TITLE) { setIssue(text(`标题不能超过 ${MAX_QUICK_MESSAGE_TITLE} 个字符。`, `Titles are limited to ${MAX_QUICK_MESSAGE_TITLE} characters.`)); return; }
    if (!body) { setIssue(text("请输入要插入的内容。", "Enter the text to insert.")); return; }
    if (quickMessageLength(body) > MAX_QUICK_MESSAGE_TEXT) { setIssue(text(`内容不能超过 ${MAX_QUICK_MESSAGE_TEXT} 个字符。`, `Text is limited to ${MAX_QUICK_MESSAGE_TEXT} characters.`)); return; }
    if (draft.isNew && messages.length >= MAX_QUICK_MESSAGES) { setIssue(text(`最多保存 ${MAX_QUICK_MESSAGES} 条快捷消息。`, `Up to ${MAX_QUICK_MESSAGES} quick messages can be saved.`)); return; }
    const next = draft.isNew
      ? [...messages, { id: draft.id, title, text: body }]
      : messages.map(message => message.id === draft.id ? { id: draft.id, title, text: body } : message);
    save(next);
  };

  const remove = (id: string) => save(messages.filter(message => message.id !== id));
  const move = (index: number, delta: -1 | 1) => save(moveQuickMessage(messages, index, delta));
  const startNew = () => { if (messages.length >= MAX_QUICK_MESSAGES) { setIssue(text(`最多保存 ${MAX_QUICK_MESSAGES} 条快捷消息。`, `Up to ${MAX_QUICK_MESSAGES} quick messages can be saved.`)); return; } setIssue(undefined); setDraft({ id: createQuickMessageId(messages), title: "", text: "", isNew: true }); };

  return <>
    <div className="setting-divider" />
    <h4>{text("快捷消息", "Quick messages")}</h4>
    <p className="hint">{text("在编写器的 + 菜单或右键菜单中，于光标处插入这些常用内容。", "The composer's + menu and right-click menu insert these snippets at the caret.")}</p>
    {messages.length ? <ul className="quick-messages-list" data-testid="quick-messages-list">
      {messages.map((message, index) => draft && !draft.isNew && draft.id === message.id
        ? <li key={message.id}><DraftEditor draft={draft} setDraft={setDraft} busy={busy} onSave={commitDraft} onCancel={() => { setDraft(undefined); setIssue(undefined); }} text={text} /></li>
        : <li className="quick-messages-row" key={message.id} data-testid="quick-message-row" data-quick-message-id={message.id}>
          <span className="quick-messages-summary"><strong>{message.title}</strong><small title={message.text}>{message.text}</small></span>
          <span className="quick-messages-actions">
            <button type="button" className="icon-btn icon-btn-sm" disabled={busy || index === 0} aria-label={text(`上移 ${message.title}`, `Move ${message.title} up`)} title={text("上移", "Move up")} data-testid="quick-message-up" onClick={() => move(index, -1)}><Icon name="arrowUp" /></button>
            <button type="button" className="icon-btn icon-btn-sm" disabled={busy || index === messages.length - 1} aria-label={text(`下移 ${message.title}`, `Move ${message.title} down`)} title={text("下移", "Move down")} data-testid="quick-message-down" onClick={() => move(index, 1)}><Icon name="arrowUp" className="is-flipped" /></button>
            <button type="button" className="btn btn-sm" disabled={busy} data-testid="quick-message-edit" onClick={() => { setIssue(undefined); setDraft({ id: message.id, title: message.title, text: message.text, isNew: false }); }}>{text("编辑", "Edit")}</button>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} data-testid="quick-message-delete" onClick={() => remove(message.id)}>{text("删除", "Delete")}</button>
          </span>
        </li>)}
    </ul> : !draft && <p className="hint" data-testid="quick-messages-empty">{text("还没有快捷消息。", "No quick messages yet.")}</p>}
    {draft?.isNew && <div className="quick-message-draft"><DraftEditor draft={draft} setDraft={setDraft} busy={busy} onSave={commitDraft} onCancel={() => { setDraft(undefined); setIssue(undefined); }} text={text} /></div>}
    <button type="button" className="btn btn-sm" disabled={busy || draft !== undefined || messages.length >= MAX_QUICK_MESSAGES} data-testid="quick-message-add" onClick={startNew}>{text("添加快捷消息", "Add quick message")}</button>
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </>;
}

function DraftEditor({ draft, setDraft, busy, onSave, onCancel, text }: { draft: Draft; setDraft: (value: Draft) => void; busy: boolean; onSave: () => void; onCancel: () => void; text: (cn: string, en: string) => string }) {
  return <div className="quick-message-editor" data-testid="quick-message-editor">
    <label>{text("标题", "Title")}<input type="text" value={draft.title} maxLength={MAX_QUICK_MESSAGE_TITLE} disabled={busy} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
    <label>{text("内容", "Text")}<textarea value={draft.text} rows={3} disabled={busy} onChange={event => setDraft({ ...draft, text: event.target.value })} /></label>
    <div className="quick-message-editor-foot"><span className="hint">{quickMessageLength(draft.text)} / {MAX_QUICK_MESSAGE_TEXT}</span><span className="quick-message-editor-actions">
      <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>{text("取消", "Cancel")}</button>
      <button type="button" className="btn btn-sm btn-primary" disabled={busy} data-testid="quick-message-save" onClick={onSave}>{text("保存", "Save")}</button>
    </span></div>
  </div>;
}
