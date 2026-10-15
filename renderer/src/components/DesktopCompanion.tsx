import { useRef, useState, type PointerEvent } from "react";
import type { Session } from "@threadterm/protocol";
import type { Locale } from "../i18n";
import { Icon } from "./PrototypeIcon";

type Props = {
  sessions: Session[];
  unreadInbox: number;
  locale: Locale;
  onOpenInbox: () => void;
  onOpenActive: () => void;
  onClose: () => void;
};

const isActive = (session: Session) =>
  !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status);

export function DesktopCompanion({
  sessions,
  unreadInbox,
  locale,
  onOpenInbox,
  onOpenActive,
  onClose,
}: Props) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragStart = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const text = locale === "zh-CN"
    ? { title: "桌面伴侣", active: "活跃", waiting: "等待", errors: "错误", open: "打开活跃会话", inbox: "打开待处理", move: "移动桌面伴侣", reset: "重置位置", close: "关闭" }
    : { title: "Desktop companion", active: "Active", waiting: "Waiting", errors: "Errors", open: "Open active sessions", inbox: "Open attention inbox", move: "Move desktop companion", reset: "Reset position", close: "Close" };
  const counts = sessions.reduce(
    (value, session) => ({
      active: value.active + Number(isActive(session)),
      waiting: value.waiting + Number(!session.readOnly && session.status === "waiting"),
      errors: value.errors + Number(session.status === "error"),
    }),
    { active: 0, waiting: 0, errors: 0 },
  );
  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { x: event.clientX, y: event.clientY, originX: position.x, originY: position.y };
  };
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const start = dragStart.current;
    if (!start) return;
    setPosition({
      x: Math.max(-window.innerWidth + 180, Math.min(window.innerWidth - 80, start.originX + event.clientX - start.x)),
      y: Math.max(-window.innerHeight + 80, Math.min(window.innerHeight - 48, start.originY + event.clientY - start.y)),
    });
  };
  const endDrag = () => { dragStart.current = null; };
  const moveByKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const distance = event.shiftKey ? 24 : 8;
    const delta = event.key === "ArrowLeft" ? [-distance, 0] : event.key === "ArrowRight" ? [distance, 0] : event.key === "ArrowUp" ? [0, -distance] : event.key === "ArrowDown" ? [0, distance] : undefined;
    if (!delta) return;
    event.preventDefault();
    setPosition((current) => ({ x: current.x + delta[0], y: current.y + delta[1] }));
  };
  return (
    <aside className="desktop-companion" aria-label={text.title} style={{ transform: `translate(${position.x}px, ${position.y}px)` }}>
      <div className="desktop-companion-title">
        <button className="icon-btn icon-btn-sm desktop-companion-drag" aria-label={text.move} title={text.move} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={moveByKey}><svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" /></svg></button>
        <strong>{text.title}</strong>
        <button className="icon-btn icon-btn-sm" aria-label={text.close} title={text.close} onClick={onClose}><Icon name="close" /></button>
      </div>
      <button className="btn desktop-companion-summary" onClick={onOpenActive} aria-label={`${text.open}: ${counts.active}`}>
        <span>{text.active}<b>{counts.active}</b></span><span>{text.waiting}<b>{counts.waiting}</b></span><span>{text.errors}<b>{counts.errors}</b></span>
      </button>
      {(counts.errors > 0 || unreadInbox > 0) && <button className="btn btn-sm desktop-companion-inbox" onClick={onOpenInbox}>{text.inbox} ({Math.max(counts.errors, unreadInbox)})</button>}
      <button className="btn btn-sm desktop-companion-reset" onClick={() => setPosition({ x: 0, y: 0 })}>{text.reset}</button>
    </aside>
  );
}
