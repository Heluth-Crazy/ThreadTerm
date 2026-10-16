import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { clampContextMenu, menuText, nextMenuIndex } from '../contextMenuActions';
import './context-menu.css';
import { useBrowserOcclusion } from '../browserOcclusion';

export type ContextMenuItem = {
  id?: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  reason?: string;
  separator?: boolean;
  danger?: boolean;
  onSelect?: () => void | Promise<void>;
  testId?: string;
};
export type ContextMenuRequest = { x: number; y: number; items: ContextMenuItem[]; restoreFocus?: HTMLElement | null; onDismiss?: (selected?: ContextMenuItem) => void };
let active: { root: Root; container: HTMLDivElement; close: (restore?: boolean, selected?: ContextMenuItem) => void } | undefined;

function defaultIcon(item: ContextMenuItem) {
  const key = item.id ?? item.testId ?? '';
  const path = key.includes('copy') ? <><rect x="8" y="8" width="12" height="13" rx="1.5"/><path d="M15 4H4v12"/></>
    : key.includes('cut') ? <><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8.5 7.5 12 12m-12-3 12-12"/></>
      : key.includes('paste') ? <><path d="M8 5H5v16h14V5h-3"/><rect x="8" y="3" width="8" height="4" rx="1"/></>
        : key.includes('comment') ? <path d="M4 4h16v12H9l-5 4z"/>
          : key.includes('send') ? <><path d="m3 3 18 9-18 9 4-9zM7 12h14"/></>
            : key.includes('history') ? <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>
              : key.includes('reload') ? <><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 6"/></>
                : key.includes('unstage') ? <path d="M5 12h14"/>
                  : key.includes('stage') ? <path d="M12 5v14M5 12h14"/>
                    : key.includes('discard') ? <><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></>
                      : key.includes('open-changes') ? <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></>
                        : key.endsWith('-source') || key.includes('show-source') ? <><path d="m8 5-6 7 6 7m8-14 6 7-6 7"/></>
                  : key.includes('plan') ? <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></>
                    : key.includes('select-all') ? <><rect x="4" y="4" width="16" height="16" strokeDasharray="3 2"/><path d="M8 12h8"/></> : undefined;
  return path && <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>;
}

export function closeContextMenu() { active?.close(); }

/** A single host is created only on demand, outside every scrolling surface. */
export function showContextMenu(request: ContextMenuRequest) {
  active?.close(false);
  if (!request.items.length) return;
  const previousFocus = request.restoreFocus === undefined ? document.activeElement : request.restoreFocus;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const host = { root, container, close: (restore = true, selected?: ContextMenuItem) => {
    if (active !== host) return;
    active = undefined;
    // Restore before the action runs so dialogs and navigation can claim focus afterwards.
    if (restore && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    try { request.onDismiss?.(selected); }
    finally { queueMicrotask(() => { root.unmount(); container.remove(); }); }
  } };
  active = host;
  root.render(<ContextMenu {...request} onClose={host.close} />);
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuRequest & { onClose: (restore?: boolean, selected?: ContextMenuItem) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const text = (en: string, zh: string) => menuText(document.documentElement.lang, en, zh);
  useBrowserOcclusion();
  useLayoutEffect(() => {
    const element = panel.current!;
    const rect = element.getBoundingClientRect();
    setPosition(clampContextMenu(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight));
    element.querySelector<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
    if (!element.contains(document.activeElement)) element.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!element.contains(event.target as Node)) onClose(); };
    const dismiss = () => onClose();
    const scroll = (event: Event) => { if (event.target !== element && !element.contains(event.target as Node)) onClose(); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [x, y, onClose]);
  const choose = (item: ContextMenuItem) => {
    if (item.disabled || !item.onSelect) return;
    // Focus restoration happens before actions open dialogs or navigate to a new target.
    try {
      const action = item.onSelect;
      onClose(true, item);
      const result = action();
      if (result) void result.catch(() => {
        showContextMenu({ x, y, items: [{ label: text('Action failed. Try again.', '操作失败，请重试。'), disabled: true, reason: text('The action could not be completed.', '无法完成此操作。') }] });
      });
    } catch {
      showContextMenu({ x, y, items: [{ label: text('Action failed. Try again.', '操作失败，请重试。'), disabled: true, reason: text('The action could not be completed.', '无法完成此操作。') }] });
    }
  };
  return <div ref={panel} data-testid="context-menu" className="popover app-context-menu" role="menu" aria-label={text('Actions', '操作')} tabIndex={-1} style={position} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = Array.from(panel.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])'));
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextMenuIndex(event.key, index, buttons.length);
    buttons[next].focus({ preventScroll: true });
  }}>
    {items.map((item, index) => item.separator ? <div key={item.id ?? index} className="app-context-separator" role="separator" /> : <button key={item.id ?? index} type="button" role="menuitem" tabIndex={-1} aria-keyshortcuts={item.shortcut} aria-disabled={item.disabled || undefined} aria-description={item.disabled ? item.reason : undefined} title={item.disabled ? item.reason : undefined} data-testid={item.testId} className={`menu-item app-context-item${item.danger ? ' danger' : ''}`} onClick={() => choose(item)}>
      <span className="app-context-icon" aria-hidden="true">{item.icon ?? defaultIcon(item)}</span>
      <span className="app-context-label">{item.label}</span>{item.shortcut && <kbd aria-hidden="true">{item.shortcut}</kbd>}
    </button>)}
  </div>;
}
