import { useEffect, useRef, useState } from 'react';
import { Icon } from './PrototypeIcon';

type Props = {
  kind: 'send' | 'queue' | 'split';
  disabled: boolean;
  busy: boolean;
  copy: (en: string, zh: string) => string;
  onInsert: () => void;
};

/** Queue stays the main action. The arrow only offers insert-into-turn. */
export function SteerSend({ kind, disabled, busy, copy, onInsert }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (returnFocus: boolean) => {
      setOpen(false);
      if (returnFocus) arrowRef.current?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(true);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);
  const label = busy ? copy('Sending…', '正在发送…') : kind === 'send' ? copy('Send', '发送') : copy('Queue', '加入队列');
  const main = <button className={`icon-btn icon-btn-sm icon-btn-round is-primary chat-compose-send${kind === 'queue' || kind === 'split' ? ' is-queue' : ''}`} type="submit" disabled={disabled} aria-label={label}><Icon name={kind === 'send' ? 'arrowUp' : 'clock'} /></button>;
  if (kind !== 'split') return main;
  return <div className="chat-steer-send" ref={rootRef} data-testid="steer-send">
    {main}
    <button ref={arrowRef} type="button" className="icon-btn icon-btn-sm icon-btn-round is-primary chat-compose-send" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-label={copy('More send actions', '更多发送操作')} onClick={() => setOpen(value => !value)}><Icon name="chevD" /></button>
    {open && <div className="chat-compose-menu chat-steer-menu" role="menu" data-testid="steer-menu">
      <button type="button" role="menuitem" className="chat-menu-item" data-testid="steer-insert" disabled={disabled} onClick={() => { setOpen(false); arrowRef.current?.focus(); onInsert(); }}>{copy('Insert into current turn', '插入当前回合')}</button>
    </div>}
  </div>;
}
