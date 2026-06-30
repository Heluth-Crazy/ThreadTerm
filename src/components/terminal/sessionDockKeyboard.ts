export const SESSION_DOCK_KEY_EVENT = 'threadterm:session-dock-key';

export interface SessionDockKeyDetail {
  key: string;
}

const SESSION_DOCK_NAVIGATION_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'Home',
  'End',
  'Enter',
  'Escape',
]);

export function isSessionDockSelectionKey(key: string): boolean {
  return /^[0-9]$/.test(key) || SESSION_DOCK_NAVIGATION_KEYS.has(key);
}

export function isSessionDockKeyboardActive(): boolean {
  return Boolean(document.querySelector('[data-session-dock-active="true"]'));
}

export function shouldForwardKeyToSessionDock(event: KeyboardEvent): boolean {
  if (event.altKey) return false;
  if (event.ctrlKey || event.metaKey) return /^[0-9]$/.test(event.key);
  return isSessionDockSelectionKey(event.key);
}

export function dispatchSessionDockKey(key: string): void {
  window.dispatchEvent(
    new CustomEvent<SessionDockKeyDetail>(SESSION_DOCK_KEY_EVENT, {
      detail: { key },
    }),
  );
}
