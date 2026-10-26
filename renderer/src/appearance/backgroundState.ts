import { useSyncExternalStore } from 'react';

export const backgroundLayoutEvent = 'threadterm:background-layout';
let terminalImage = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setTerminalBackground(active: boolean) {
  if (active === terminalImage) return;
  terminalImage = active;
  for (const listener of listeners) listener();
}

export function useTerminalBackground(): boolean {
  return useSyncExternalStore(subscribe, () => terminalImage);
}
