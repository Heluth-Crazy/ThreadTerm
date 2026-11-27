/*
 * The app's hover tips (owner 2026-11-26: 「有的图标不放上去，根本不知道是什么」). Icon-only buttons say what they do
 * after a short rest, the way VS Code's and T3 Code's toolbars do; the OS `title` tooltip waits about a second and
 * looks foreign. Pure decisions here; `components/HoverTip.tsx` wires them to the DOM.
 */

/** First tip after the pointer rests this long. */
export const TIP_DELAY_MS = 350;
/** Moving to the next button within this long after a tip closed shows its tip at once. */
export const TIP_WARM_MS = 600;
const GAP = 6, MARGIN = 6;

/** What a tip needs to know about a candidate element; a DOM element satisfies it. */
export interface TipCandidate {
  readonly tagName: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

/** The text a tip shows for an element, or undefined when it gets none. Only icon-only buttons (and anything marked
 * `data-tip`) get one: a button that shows its words needs no tip. `stashedTitle` is the `title` this module took off
 * the element so the OS does not show its own tooltip on top. */
export function tipText(element: TipCandidate, stashedTitle?: string): string | undefined {
  const explicit = element.getAttribute('data-tip');
  if (explicit !== null) return explicit.trim() || undefined;
  const button = element.tagName === 'BUTTON' || element.getAttribute('role') === 'button';
  if (!button || (element.textContent ?? '').trim()) return undefined;
  const text = element.getAttribute('aria-label') ?? stashedTitle ?? element.getAttribute('title');
  return text?.trim() || undefined;
}

/** `aria-keyshortcuts` as people read it: `Control+Shift+P` → `Ctrl+Shift+P`; the first of several. */
export function tipShortcut(element: TipCandidate): string | undefined {
  const value = element.getAttribute('aria-keyshortcuts')?.trim().split(/\s+/)[0];
  return value ? value.replace(/\bControl\b/g, 'Ctrl').replace(/\bMeta\b/g, 'Win') : undefined;
}

export interface Box { left: number; top: number; width: number; height: number }

/** Where the tip goes: centred below its anchor, above when there is no room below, always inside the window. */
export function placeTip(anchor: Box, tip: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number; side: 'below' | 'above' } {
  const below = anchor.top + anchor.height + GAP;
  const side = below + tip.height + MARGIN <= viewport.height || anchor.top - GAP - tip.height < MARGIN ? 'below' : 'above';
  const top = side === 'below' ? below : anchor.top - GAP - tip.height;
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.min(Math.max(centred, MARGIN), Math.max(MARGIN, viewport.width - MARGIN - tip.width));
  return { left: Math.round(left), top: Math.round(top), side };
}
