import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { NoteTarget } from './FileComments';
import './editor-selection-actions.css';

/** Comment and Send for a text selection in a view without line numbers (a large-file window, rendered Markdown). */
export type TextSelectionHandlers = {
  zh: boolean;
  canComment: boolean;
  onComment: (target: NoteTarget) => void;
  onSend?: (target: NoteTarget) => void;
  /** The current selection, or undefined once it collapses; the file bar's Comment button comments on it. */
  onSelection?: (target: NoteTarget | undefined) => void;
};

const STRIP_WIDTH = 200;

/**
 * Watches the selection inside `host` (its DOM text, or a textarea in it) and returns the action strip that the caller
 * renders inside `host`, which must be `position:relative`. The strip uses the code editor's selection-strip look.
 * `offsetOf` gives a textarea selection's byte offset in the file (large-file windows).
 */
export function useTextSelectionActions(host: RefObject<HTMLElement | null>, handlers: TextSelectionHandlers | undefined, offsetOf?: (area: HTMLTextAreaElement) => number | undefined) {
  const [strip, setStrip] = useState<{ target: NoteTarget; left: number; top: number }>();
  const latest = useRef({ handlers, offsetOf });
  latest.current = { handlers, offsetOf };
  const enabled = Boolean(handlers);
  useEffect(() => {
    const element = host.current;
    if (!element || !enabled) return;
    let pressed = false, pointer: { x: number; y: number } | undefined;
    const read = () => {
      const box = element.getBoundingClientRect(), active = document.activeElement;
      let text = '', offset: number | undefined, anchor: { x: number; y: number } | undefined;
      if (active instanceof HTMLTextAreaElement && element.contains(active)) {
        text = active.value.slice(active.selectionStart, active.selectionEnd);
        if (text.trim()) offset = latest.current.offsetOf?.(active);
        anchor = pointer ?? { x: box.right - STRIP_WIDTH, y: box.top + 40 };
      } else {
        const selection = document.getSelection(), range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : undefined;
        if (range && element.contains(range.commonAncestorContainer)) {
          text = selection!.toString();
          const rect = range.getBoundingClientRect();
          anchor = { x: rect.left, y: rect.bottom };
        }
      }
      if (!text.trim() || !anchor) { setStrip(undefined); latest.current.handlers?.onSelection?.(undefined); return; }
      const target: NoteTarget = offset === undefined ? { text } : { text, offset };
      setStrip({
        target,
        left: Math.max(8, Math.min(anchor.x - box.left, box.width - STRIP_WIDTH)) + element.scrollLeft,
        top: Math.max(4, Math.min(anchor.y - box.top + 6, box.height - 36)) + element.scrollTop,
      });
      latest.current.handlers?.onSelection?.(target);
    };
    const down = () => { pressed = true; };
    const up = (event: PointerEvent) => {
      if (!pressed) return;
      pressed = false;
      pointer = { x: event.clientX, y: event.clientY };
      requestAnimationFrame(read);
    };
    const keyed = () => { pointer = undefined; read(); };
    const changed = () => { if (!pressed) read(); };
    // Text under a fixed strip moves when an inner box scrolls; the selection stays, the strip waits for the next one.
    const scrolled = () => setStrip(undefined);
    element.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    element.addEventListener('keyup', keyed);
    document.addEventListener('selectionchange', changed);
    element.addEventListener('scroll', scrolled, true);
    return () => {
      element.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      element.removeEventListener('keyup', keyed);
      document.removeEventListener('selectionchange', changed);
      element.removeEventListener('scroll', scrolled, true);
      setStrip(undefined);
    };
  }, [host, enabled]);
  if (!strip || !handlers || (!handlers.canComment && !handlers.onSend)) return null;
  const { zh } = handlers;
  return <div className="editor-selection-actions file-selection-actions" style={{ '--selection-left': `${strip.left}px`, '--selection-top': `${strip.top}px` } as CSSProperties}>
    {handlers.canComment && <button type="button" className="btn btn-sm" onMouseDown={event => event.preventDefault()} onClick={() => { handlers.onComment(strip.target); setStrip(undefined); }}>{zh ? '评论' : 'Comment'}</button>}
    {handlers.onSend && <button type="button" className="btn btn-sm" onMouseDown={event => event.preventDefault()} onClick={() => handlers.onSend?.(strip.target)}>{zh ? '发送选中内容' : 'Send selection'}</button>}
  </div>;
}
