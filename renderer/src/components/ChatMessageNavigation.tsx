import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatItem } from '@threadterm/protocol';
import { messageDestinations, messageWindow } from '../chatMessageNavigation';
import { useBrowserOcclusion } from '../browserOcclusion';
import { Icon } from './PrototypeIcon';
import './chat-message-navigation.css';

type Props = { items: readonly ChatItem[]; copy: (en: string, zh: string) => string; onNavigate: (id: string) => void; stats?: ReadonlyMap<string, { additions: number; deletions: number }> };
export function ChatMessageNavigation({ items, copy, onNavigate, stats }: Props) {
  const messages = useMemo(() => messageDestinations(items, stats), [items, stats]);
  const [open, setOpen] = useState(false), [top, setTop] = useState(0);
  const popoverId = useId();
  useBrowserOcclusion(open);
  const [placement, setPlacement] = useState<{ left: number; top: number; width: number; maxHeight: number }>();
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); trigger.current?.focus({ preventScroll: true }); } };
    // The list is a dialog. Escape must close it even when programmatic focus
    // could not move into the list (the key then targets document, not this div).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', onKey);
    list.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  // The trigger lives in the session header now, so anchor to its viewport rect
  // instead of the transcript; fixed placement also escapes the header's clipping.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
    const top = Math.min(anchor.bottom + 6, window.innerHeight - 120);
    setPlacement({ left, top, width, maxHeight: Math.max(160, Math.min(420, window.innerHeight - top - 16)) });
  }, [open]);
  if (messages.length < 3) return null;
  const visible = messageWindow(messages.length, top);
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
    <button ref={trigger} type="button" className="icon-btn chat-message-navigation-trigger" aria-expanded={open} aria-controls={popoverId} aria-label={copy(`Messages ${messages.length}`, `消息 ${messages.length}`)} title={copy(`Messages ${messages.length}`, `消息 ${messages.length}`)} onClick={() => { setTop(0); setOpen(value => !value); }}><Icon name="layers" /></button>
    {open && <div id={popoverId} className="chat-message-popover" style={placement} role="dialog" aria-label={copy('Message navigation', '消息导航')}>
      <div className="chat-message-list" ref={list} onScroll={event => setTop(event.currentTarget.scrollTop)}>
        {!!visible.before && <div aria-hidden="true" style={{ height: visible.before }} />}
        {messages.slice(visible.start, visible.end).map((message, offset) => <div className="chat-message-destination" key={message.id}>
          <button type="button" className="btn btn-sm btn-ghost" data-message-index={visible.start + offset} title={message.preview} onClick={() => { close(); onNavigate(message.id); }}>{visible.start + offset + 1}. {message.preview || copy('Image or context', '图片或上下文')}</button>
          <span><time dateTime={message.createdAt}>{Number.isFinite(Date.parse(message.createdAt)) ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</time>{message.additions !== undefined && <span> +{message.additions} −{message.deletions ?? 0}</span>}</span>
        </div>)}
        {!!visible.after && <div aria-hidden="true" style={{ height: visible.after }} />}
      </div>
    </div>}
  </div>;
}
