import { useLayoutEffect, type RefObject } from 'react';
import { browserCommand } from './bridge';

/** Small, pure reference counter so overlapping portalled surfaces restore the page once. */
export function createBrowserOcclusionLedger(onChange: (active: boolean) => void) {
  let count = 0;
  return {
    acquire() {
      if (count++ === 0) onChange(true);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (count > 0 && --count === 0) onChange(false);
      };
    },
    get count() { return count; },
  };
}

let visibleSurfaces = 0;
let sent = false;
const leases = createBrowserOcclusionLedger(active => sync(active));

function sync(active: boolean) {
  const next = visibleSurfaces > 0 && active;
  if (next === sent) return;
  sent = next;
  void browserCommand({ type: 'occlusion', active: next }).catch(() => undefined);
}

/** Hide the native page until every current overlay has released its lease. */
export function acquireBrowserOcclusion(): () => void { return leases.acquire(); }

/** React lease for shared overlay primitives. */
export function useBrowserOcclusion(active = true): void {
  useLayoutEffect(() => active ? acquireBrowserOcclusion() : undefined, [active]);
}

type Rect = { x: number; y: number; width: number; height: number };

/** Passive notices need a snapshot only where they would cover a native page. */
export function browserOverlayIntersectsPage(overlay: Rect, pages: readonly Rect[]): boolean {
  return overlay.width > 0 && overlay.height > 0 && pages.some(page =>
    page.width > 0 && page.height > 0 && overlay.x < page.x + page.width &&
    overlay.x + overlay.width > page.x && overlay.y < page.y + page.height && overlay.y + overlay.height > page.y,
  );
}

const pageSurfaces = new Set<HTMLElement>();
const passiveOverlays = new Set<HTMLElement>();
const observedPassive = new Set<HTMLElement>();
let passiveResize: ResizeObserver | undefined;
let passiveMutation: MutationObserver | undefined;

/** Explicit registration also covers notices mounted inside the React app root. */
export function usePassiveBrowserOcclusion(ref: RefObject<HTMLElement | null>, active = true): void {
  useLayoutEffect(() => {
    if (!active) return;
    const element = ref.current;
    if (!element) return;
    passiveOverlays.add(element);
    if (visibleSurfaces) updateFallback();
    return () => { passiveOverlays.delete(element); if (visibleSurfaces) scheduleFallbackUpdate(); };
  }, [ref, active]);
}

/** Called by the visible page's existing bounds observer; no second page observer. */
export function updateBrowserOverlayBounds(): void { if (visibleSurfaces) updateFallback(); }

const passiveOverlay = '.toast, .attention-toast, .wb-web-preview-note';
const portalOverlay = '[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], .overlay, .popover, .scrim, .settings-drawer, .selection-bubble, .chat-connection-popover, [data-tooltip]:hover';
let observer: MutationObserver | undefined;
let releaseFallback: (() => void) | undefined;
let scanFrame = 0;
let interaction: ((event?: Event) => void) | undefined;

function updateFallback() {
  const passive = new Set([...passiveOverlays, ...document.querySelectorAll<HTMLElement>(passiveOverlay)]);
  // Observe only notices, and only for the lifetime of a visible browser surface.
  // Attribute changes cover repositioning without a size change.
  if (passive.size) {
    passiveResize ??= new ResizeObserver(scheduleFallbackUpdate);
    passiveMutation ??= new MutationObserver(scheduleFallbackUpdate);
    for (const element of observedPassive) if (!passive.has(element)) passiveResize.unobserve(element);
    passiveMutation.disconnect();
    for (const element of passive) {
      if (!observedPassive.has(element)) passiveResize.observe(element);
      passiveMutation.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'] });
    }
  } else {
    passiveResize?.disconnect(); passiveResize = undefined;
    passiveMutation?.disconnect(); passiveMutation = undefined;
  }
  observedPassive.clear(); passive.forEach(element => observedPassive.add(element));
  const visible = (element: HTMLElement) => !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0;
  const pages = [...pageSurfaces].filter(visible).map(element => element.getBoundingClientRect());
  const active = Array.from(document.querySelectorAll<HTMLElement>(portalOverlay)).some(element =>
    !element.closest(passiveOverlay) && visible(element),
  ) || [...passive].some(element => visible(element) && browserOverlayIntersectsPage(element.getBoundingClientRect(), pages));
  if (active && !releaseFallback) releaseFallback = acquireBrowserOcclusion();
  if (!active && releaseFallback) { releaseFallback(); releaseFallback = undefined; }
}

function scheduleFallbackUpdate() {
  if (scanFrame) return;
  scanFrame = requestAnimationFrame(() => { scanFrame = 0; updateFallback(); });
}

function startFallbackWatcher() {
  const listener = (event?: Event) => {
    if(event instanceof KeyboardEvent&&!event.ctrlKey&&!event.metaKey){
      if(!['Escape','Enter',' ','Tab','ArrowDown','ArrowUp'].includes(event.key))return;
      if(event.target instanceof Element&&event.target.closest('input,textarea,[contenteditable=true]')&&!['Escape','Tab'].includes(event.key))return;
    }
    if(event?.type==='pointerup'&&event.target instanceof Element&&event.target.closest('button[type=submit]'))return;
    scheduleFallbackUpdate();
  };
  interaction = listener;
  observer = new MutationObserver(records => {
    if (records.some(record => record.type === 'childList')) updateFallback();
  });
  observer.observe(document.body, { childList: true });
  document.addEventListener('pointerup', listener, true);
  document.addEventListener('keydown', listener, true);
  document.addEventListener('focusin', listener, true);
  updateFallback();
}

function stopFallbackWatcher() {
  observer?.disconnect(); observer = undefined;
  passiveResize?.disconnect(); passiveResize = undefined;
  passiveMutation?.disconnect(); passiveMutation = undefined;
  observedPassive.clear();
  if (scanFrame) cancelAnimationFrame(scanFrame); scanFrame = 0;
  if (interaction) {
    document.removeEventListener('pointerup', interaction, true);
    document.removeEventListener('keydown', interaction, true);
    document.removeEventListener('focusin', interaction, true);
    interaction = undefined;
  }
  releaseFallback?.(); releaseFallback = undefined;
}

/**
 * Event-driven fallback for portalled overlays outside the shared primitives.
 * WebPreview starts this only while its native WebContentsView is visible.
 */
export function watchBrowserOverlays(element?: HTMLElement): () => void {
  if (element) pageSurfaces.add(element);
  visibleSurfaces += 1;
  if (visibleSurfaces === 1) startFallbackWatcher();
  else updateFallback();
  sync(leases.count > 0);
  return () => {
    if (element) pageSurfaces.delete(element);
    visibleSurfaces = Math.max(0, visibleSurfaces - 1);
    if (!visibleSurfaces) stopFallbackWatcher();
    else updateFallback();
    sync(leases.count > 0);
  };
}
