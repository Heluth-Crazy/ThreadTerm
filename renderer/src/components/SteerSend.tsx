import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { nextMenuIndex } from '../contextMenuActions';
import { listenForSteerMenuDismissal } from '../steerMenu';
import { Icon } from './PrototypeIcon';

type SendKind = 'send' | 'queue' | 'split' | 'split-note';
type Props = {
  kind: SendKind;
  disabled: boolean;
  busy: boolean;
  copy: (en: string, zh: string) => string;
  onInsert: () => void;
  /** E2 note sessions: the arrow offers a note for the agent's next check. */
  onNote?: () => void;
  noteDisabled?: boolean;
  noteDisabledReason?: string;
};

/**
 * Queue stays the main action. The arrow offers a second action: insert into
 * the running turn for native steering, or a note for `feedback_check`.
 */
export function SteerSend({ kind, disabled, busy, copy, onInsert, onNote, noteDisabled = false, noteDisabledReason }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    return listenForSteerMenuDismissal(document, node => Boolean(rootRef.current?.contains(node as Node)), reason => {
      setOpen(false);
      if (reason === 'escape') arrowRef.current?.focus();
    });
  }, [open]);
  const split = kind === 'split' || kind === 'split-note';
  const onMenuKey = (event: ReactKeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (!items.length) return;
    event.preventDefault();
    items[nextMenuIndex(event.key, items.indexOf(document.activeElement as HTMLButtonElement), items.length)]?.focus();
  };
  const label = busy ? copy('Sending…', '正在发送…') : kind === 'send' ? copy('Send', '发送') : copy('Queue', '加入队列');
  const main = <button className={`icon-btn icon-btn-sm icon-btn-round is-primary chat-compose-send${kind === 'queue' || split ? ' is-queue' : ''}`} type="submit" disabled={disabled} aria-label={label}><Icon name={kind === 'send' ? 'arrowUp' : 'clock'} /></button>;
  if (!split) return main;
  const note = kind === 'split-note';
  const itemDisabled = note ? noteDisabled : disabled;
  return <div className="chat-steer-send" ref={rootRef} data-testid="steer-send" data-steer-kind={kind}>
    {main}
    <button ref={arrowRef} type="button" className="icon-btn icon-btn-sm icon-btn-round is-primary chat-compose-send" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-label={copy('More send actions', '更多发送操作')} onClick={() => setOpen(value => !value)}><Icon name="chevD" /></button>
    {open && <div className="chat-compose-menu chat-steer-menu" role="menu" data-testid="steer-menu" ref={menuRef} onKeyDown={onMenuKey}>
      {note
        ? <button type="button" role="menuitem" className="menu-item chat-menu-item" data-testid="steer-note" disabled={itemDisabled} title={noteDisabled ? noteDisabledReason : undefined} onClick={() => { setOpen(false); arrowRef.current?.focus(); onNote?.(); }}>{copy('Send note for next check', '发送备注供下次检查')}</button>
        : <button type="button" role="menuitem" className="menu-item chat-menu-item" data-testid="steer-insert" disabled={itemDisabled} onClick={() => { setOpen(false); arrowRef.current?.focus(); onInsert(); }}>{copy('Insert into current turn', '插入当前回合')}</button>}
    </div>}
  </div>;
}
