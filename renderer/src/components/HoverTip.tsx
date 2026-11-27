import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePassiveBrowserOcclusion } from '../browserOcclusion';
import { placeTip, TIP_DELAY_MS, TIP_WARM_MS, tipShortcut, tipText } from '../hoverTip';
import './hover-tip.css';

interface Shown { anchor: HTMLElement; text: string; shortcut?: string }

/**
 * One hover tip for the whole window (see `hoverTip.ts`). It follows the pointer over icon-only buttons and keyboard
 * focus on them, and never takes the pointer or focus itself.
 */
export function HoverTip() {
  const [shown, setShown] = useState<Shown>();
  const tip = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; side: string }>();
  usePassiveBrowserOcclusion(tip, Boolean(shown && place));

  useEffect(() => {
    let timer = 0, closedAt = 0, current: HTMLElement | undefined;
    /** The `title` taken off the current anchor, so the OS tooltip does not show over ours; put back on leave. */
    let stashed: { element: HTMLElement; title: string } | undefined;
    const restore = () => {
      if (stashed && !stashed.element.hasAttribute('title')) stashed.element.setAttribute('title', stashed.title);
      stashed = undefined;
    };
    const hide = () => {
      window.clearTimeout(timer);
      if (current) closedAt = Date.now();
      current = undefined; restore(); setShown(undefined);
    };
    const anchorOf = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('button, [role="button"], [data-tip]') ?? undefined : undefined;
    const enter = (element: HTMLElement) => {
      if (element === current) return;
      hide();
      const title = element.getAttribute('title') ?? undefined;
      const text = tipText(element, title);
      if (!text) return;
      if (title !== undefined) { stashed = { element, title }; element.removeAttribute('title'); }
      current = element;
      const show = () => { if (current === element && element.isConnected) setShown({ anchor: element, text, shortcut: tipShortcut(element) }); };
      if (Date.now() - closedAt < TIP_WARM_MS) show(); else timer = window.setTimeout(show, TIP_DELAY_MS);
    };
    const over = (event: PointerEvent) => { if (event.pointerType !== 'touch') { const anchor = anchorOf(event.target); if (anchor) enter(anchor); else if (current) hide(); } };
    const out = (event: PointerEvent) => { if (current && !(event.relatedTarget instanceof Node && current.contains(event.relatedTarget))) hide(); };
    const focus = (event: FocusEvent) => { const anchor = anchorOf(event.target); if (anchor?.matches(':focus-visible')) enter(anchor); };
    const blur = () => { if (current) hide(); };
    const dismiss = () => { if (current) { hide(); closedAt = 0; } };
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('focusout', blur, true);
    for (const name of ['pointerdown', 'keydown', 'wheel'] as const) document.addEventListener(name, dismiss, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      hide();
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('focusout', blur, true);
      for (const name of ['pointerdown', 'keydown', 'wheel'] as const) document.removeEventListener(name, dismiss, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, []);

  useLayoutEffect(() => {
    const element = tip.current;
    if (!shown || !element) { setPlace(undefined); return; }
    const anchor = shown.anchor.getBoundingClientRect();
    if (!anchor.width && !anchor.height) { setPlace(undefined); return; }
    setPlace(placeTip(anchor, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [shown]);

  if (!shown) return null;
  return createPortal(<div ref={tip} className="tt-hover-tip" role="tooltip" data-side={place?.side}
    style={place ? { left: place.left, top: place.top } : { left: -9999, top: -9999, visibility: 'hidden' }}>
    <span>{shown.text}</span>{shown.shortcut && <kbd>{shown.shortcut}</kbd>}
  </div>, document.body);
}
