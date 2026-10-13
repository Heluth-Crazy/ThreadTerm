import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatItem } from '@threadterm/protocol';
import { messageDestinations, messageWindow } from '../chatMessageNavigation';
import './chat-message-navigation.css';

type Props = { items: readonly ChatItem[]; copy: (en: string, zh: string) => string; onNavigate: (id: string) => void; stats?: ReadonlyMap<string, { additions: number; deletions: number }> };
export function ChatMessageNavigation({ items, copy, onNavigate, stats }: Props) {
  const messages = useMemo(() => messageDestinations(items, stats), [items, stats]);
  const [open, setOpen] = useState(false), [top, setTop] = useState(0);
  const [placement, setPlacement] = useState<{ left: number; width: number }>();
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    list.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const anchor = root.current.getBoundingClientRect(), pane = (root.current.closest('.chat-log-shell') ?? root.current.parentElement)?.getBoundingClientRect();
    if (!pane) return;
    const scale = root.current.offsetWidth ? anchor.width / root.current.offsetWidth : 1;
    const width = Math.min(340 * scale, pane.width - 16);
    setPlacement({ left: (Math.max(pane.left + 8, Math.min(anchor.left, pane.right - width - 8)) - anchor.left) / scale, width: width / scale });
  }, [open]);
  if (messages.length < 3) return null;
  const window = messageWindow(messages.length, top);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  return <div className="chat-message-navigation" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const current = Number((event.target as HTMLElement).dataset.messageIndex ?? 0);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? messages.length - 1 : Math.max(0, Math.min(messages.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      if (list.current) { list.current.scrollTop = next * 60; setTop(list.current.scrollTop); }
      requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`button[data-message-index="${next}"]`)?.focus({ preventScroll: true }));
    }
  }}>
    <button ref={trigger} type="button" className="chip chip-btn" aria-expanded={open} aria-label={copy('Message navigation', '消息导航')} onClick={() => { setTop(0); setOpen(value => !value); }}>{copy(`Messages ${messages.length}`, `消息 ${messages.length}`)}</button>
    {open && <div className="chat-message-popover" style={placement} role="dialog" aria-label={copy('Message navigation', '消息导航')}>
      <div className="chat-message-list" ref={list} onScroll={event => setTop(event.currentTarget.scrollTop)}>
        {!!window.before && <div aria-hidden="true" style={{ height: window.before }} />}
        {messages.slice(window.start, window.end).map((message, offset) => <div className="chat-message-destination" key={message.id}>
          <button type="button" className="btn btn-sm btn-ghost" data-message-index={window.start + offset} title={message.preview} onClick={() => { close(); onNavigate(message.id); }}>{window.start + offset + 1}. {message.preview || copy('Image or context', '图片或上下文')}</button>
          <span><time dateTime={message.createdAt}>{Number.isFinite(Date.parse(message.createdAt)) ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</time>{message.additions !== undefined && <span> +{message.additions} −{message.deletions ?? 0}</span>}</span>
        </div>)}
        {!!window.after && <div aria-hidden="true" style={{ height: window.after }} />}
      </div>
    </div>}
  </div>;
}
