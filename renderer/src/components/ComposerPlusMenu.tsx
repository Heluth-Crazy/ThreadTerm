// The composer's `+` add menu (task 10-11-chat-parity F3).
//
// One entry point for everything that inserts content: attach files through the
// native dialog, quick messages inserted at the caret, the existing slash
// panel, and a live-feedback action while a note-capable turn runs. The menu
// reuses the composer menu surface and keyboard behaviour: it opens with focus
// on the first item, moves with the arrow keys, returns focus to the `+` button
// on Escape, and closes on an outside press.
import { useEffect, useRef, useState } from "react";
import type { QuickMessage } from "@threadterm/protocol";
import { Icon } from "./PrototypeIcon";
import "./composer-plus-menu.css";

type Props = {
  quickMessages: readonly QuickMessage[];
  onAttachFiles: () => void | Promise<void>;
  onPickQuickMessage: (message: QuickMessage) => void;
  onSlashCommands: () => void;
  onLiveFeedback: () => void;
  liveFeedbackEnabled: boolean;
  disabled: boolean;
  copy: (en: string, zh: string) => string;
};

export function ComposerPlusMenu({ quickMessages, onAttachFiles, onPickQuickMessage, onSlashCommands, onLiveFeedback, liveFeedbackEnabled, disabled, copy }: Props) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"root" | "quick">("root");
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = (restore: boolean) => {
    setOpen(false);
    setPanel("root");
    if (restore) buttonRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Focus the first available item whenever a panel appears.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open, panel]);

  const closeForAction = () => {
    setOpen(false);
    setPanel("root");
    buttonRef.current?.focus({ preventScroll: true });
  };

  const navigate = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    if (!items.length) return;
    if (event.key === "ArrowLeft" && panel === "quick") {
      event.preventDefault();
      setPanel("root");
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : (index <= 0 ? items.length : index) - 1;
    items[next]?.focus({ preventScroll: true });
  };

  const quick = panel === "quick";
  return <span className="chat-plus-anchor" ref={rootRef}>
    <button
      ref={buttonRef}
      type="button"
      className="icon-btn icon-btn-sm icon-btn-round chat-compose-icon"
      data-testid="composer-plus"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={copy("Add", "添加")}
      title={copy("Add", "添加")}
      disabled={disabled}
      onClick={() => { if (open) close(false); else { setPanel("root"); setOpen(true); } }}
    >
      <Icon name="plus" />
    </button>
    {open && <div ref={menuRef} className="chat-compose-menu chat-plus-menu is-anchored" role="menu" aria-label={copy("Add", "添加")} data-testid="composer-plus-menu" data-plus-panel={panel} onKeyDown={navigate}>
      {quick ? <>
        <button type="button" role="menuitem" className="menu-item chat-plus-item" data-testid="plus-back" onClick={() => setPanel("root")}>
          <Icon name="back" className="chat-plus-back" /><span className="chat-plus-label">{copy("Quick messages", "快捷消息")}</span>
        </button>
        {quickMessages.length ? quickMessages.map(message => <button type="button" role="menuitem" key={message.id} className="menu-item chat-plus-item" data-testid="plus-quick-message" data-quick-message-id={message.id} title={message.text} onClick={() => { closeForAction(); onPickQuickMessage(message); }}>
          <span className="chat-plus-quick">
            <span className="chat-plus-quick-title">{message.title}</span>
            <span className="chat-plus-preview">{message.text}</span>
          </span>
        </button>) : <p className="chat-menu-empty" data-testid="plus-quick-empty">{copy("No quick messages yet. Add them in Settings.", "还没有快捷消息。请在设置中添加。")}</p>}
      </> : <>
        <button type="button" role="menuitem" className="menu-item chat-plus-item" data-testid="plus-attach-files" onClick={() => { closeForAction(); void onAttachFiles(); }}>
          <Icon name="file" /><span className="chat-plus-label">{copy("Attach files…", "附加文件…")}</span>
        </button>
        <button type="button" role="menuitem" className="menu-item chat-plus-item" data-testid="plus-quick-messages" aria-haspopup="menu" aria-expanded={false} onClick={() => setPanel("quick")}>
          <Icon name="spark" /><span className="chat-plus-label">{copy("Quick messages", "快捷消息")}</span><Icon name="chevR" className="chat-plus-chev" />
        </button>
        <button type="button" role="menuitem" className="menu-item chat-plus-item" data-testid="plus-slash-commands" onClick={() => { closeForAction(); onSlashCommands(); }}>
          <Icon name="chevR" /><span className="chat-plus-label">{copy("Slash commands", "斜杠命令")}</span>
        </button>
        <button type="button" role="menuitem" className="menu-item chat-plus-item" data-testid="plus-live-feedback" disabled={!liveFeedbackEnabled} title={liveFeedbackEnabled ? undefined : copy("Available while a running turn accepts feedback notes.", "仅在运行的回合接受反馈备注时可用。")} onClick={() => { closeForAction(); onLiveFeedback(); }}>
          <Icon name="clock" /><span className="chat-plus-label">{copy("Live feedback…", "实时反馈…")}</span>
        </button>
      </>}
    </div>}
  </span>;
}
