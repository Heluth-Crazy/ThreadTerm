import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { assistantSelection, selectionPosition } from '../chatSelection';
import './selection-bubble.css';

type Props = { rootRef: RefObject<HTMLElement | null>; visible: boolean; copy: (en: string, zh: string) => string; onQuote: (text: string) => void; onAsk: (text: string, current: () => boolean) => Promise<void> | void; onCopy?: (text: string) => Promise<void> | void; quoteEnabled?: boolean; askEnabled?: boolean };
export function SelectionBubble({ rootRef, visible, copy, onQuote, onAsk, onCopy, quoteEnabled = true, askEnabled = true }: Props) {
  const [selected, setSelected] = useState<{ text: string; rect: DOMRect }>(), [position, setPosition] = useState<{ left: number; top: number }>();
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string>();
  const bubble = useRef<HTMLDivElement>(null), generation = useRef(0);
  const locked = useRef(false);
  const captured = useRef<Range | null>(null);
  const retain = useRef(false);
  const shown = useRef<string | undefined>(undefined);
  const dismiss = () => {
    generation.current++; locked.current = false; captured.current = null; retain.current = false; shown.current = undefined;
    setSelected(undefined); setIssue(undefined); setBusy(false);
  };
  useEffect(() => {
    if (!visible) { dismiss(); return; }
    const root = rootRef.current;
    if (!root) return;
    const change = () => {
      const token = generation.current;
      queueMicrotask(() => {
        if (token !== generation.current) return;
        // Focusing or blurring an action collapses the DOM selection before activeElement updates.
        if (retain.current || bubble.current?.contains(document.activeElement)) return;
        const next = root.getClientRects().length ? assistantSelection(document.getSelection(), root) : undefined;
        if ((next?.text ?? '') === (shown.current ?? '')) return;
        generation.current++; locked.current = false; setBusy(false); setIssue(undefined);
        const range = next ? document.getSelection()?.getRangeAt(0) : undefined;
        captured.current = range ? range.cloneRange() : null;
        shown.current = next?.text;
        setSelected(next);
      });
    };
    document.addEventListener('selectionchange', change);
    return () => {
      generation.current++;
      document.removeEventListener('selectionchange', change);
    };
  }, [rootRef, visible]);
  useEffect(() => {
    if (!selected || !visible) return;
    const root = rootRef.current;
    const pointer = (event: PointerEvent) => { if (!bubble.current?.contains(event.target as Node)) dismiss(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (bubble.current?.contains(document.activeElement)) root?.focus({ preventScroll: true }); dismiss(); } };
    document.addEventListener('pointerdown', pointer); root?.addEventListener('scroll', dismiss, true); document.addEventListener('keydown', escape); window.addEventListener('resize', dismiss);
    return () => { document.removeEventListener('pointerdown', pointer); root?.removeEventListener('scroll', dismiss, true); document.removeEventListener('keydown', escape); window.removeEventListener('resize', dismiss); };
  }, [rootRef, selected, visible]);
  useLayoutEffect(() => {
    const root = rootRef.current, panel = bubble.current;
    if (!selected || !root || !panel) return;
    const box = panel.getBoundingClientRect(), pane = root.getBoundingClientRect();
    const placement = selectionPosition(selected.rect, pane, box.width, box.height), scale = panel.offsetWidth ? box.width / panel.offsetWidth : 1;
    setPosition({ left: placement.left / scale, top: placement.top / scale });
  }, [rootRef, selected, busy, issue]);
  if (!visible || !selected) return null;
  const action = async (callback: (text: string, current: () => boolean) => void | Promise<void>) => {
    if (locked.current) return;
    const token = generation.current; locked.current = true; setBusy(true); setIssue(undefined);
    try { await callback(selected.text, () => token === generation.current); if (token === generation.current) { document.getSelection()?.removeAllRanges(); dismiss(); } }
    catch (error) { if (token === generation.current) { locked.current = false; setIssue(String(error)); setBusy(false); } }
  };
  return createPortal(<div ref={bubble} className="selection-bubble" role="group" aria-label={copy('Selected text', '所选文本')} data-testid="selection-bubble" style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onPointerDown={event => event.preventDefault()} onFocus={() => { retain.current = true; }} onBlur={() => {
    const token = generation.current;
    const range = captured.current;
    const root = rootRef.current;
    queueMicrotask(() => {
      if (token !== generation.current) { retain.current = false; return; }
      if (!range || !root || !bubble.current?.isConnected || bubble.current.contains(document.activeElement)) return;
      const selection = document.getSelection();
      if (selection && assistantSelection(selection, root)) { retain.current = false; return; }
      try { selection?.removeAllRanges(); selection?.addRange(range); }
      catch { captured.current = null; }
      retain.current = false;
    });
  }}>
    <div className="selection-bubble-actions">
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void action(onCopy ?? (text => navigator.clipboard.writeText(text)))}>{copy('Copy', '复制')}</button>
      <button type="button" className="btn btn-sm" disabled={busy || !quoteEnabled} onClick={() => void action(onQuote)}>{copy('Quote', '引用')}</button>
      <button type="button" className="btn btn-sm" disabled={busy || !askEnabled} aria-label={copy('Ask in a new conversation', '在新对话中提问')} title={copy('Ask in a new conversation', '在新对话中提问')} onClick={() => void action(onAsk)}>{copy('Ask', '提问')}</button>
    </div>
    {issue && <p role="alert">{issue}</p>}
  </div>, document.body);
}
