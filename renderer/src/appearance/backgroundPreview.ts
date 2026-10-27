import { useSyncExternalStore } from 'react';
import { themeBackgrounds, type ThemeBackgrounds } from '../themes';

type Preview = { owner: string; backgrounds: ThemeBackgrounds };
type Message = (Preview & { type: 'preview' }) | { type: 'end'; owner: string } | { type: 'request' };
const drafts = new Map<string, ThemeBackgrounds>();
const owned = new Set<string>();
const listeners = new Set<() => void>();
let active: Preview | undefined;
const channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('threadterm-background-preview') : undefined;
function receive(message: Message) {
 if (message.type === 'request') {
  if (active && owned.has(active.owner)) channel?.postMessage({ type: 'preview', ...active });
  return;
 }
 if (message.type === 'preview') {
  const backgrounds = themeBackgrounds(message.backgrounds) ?? {};
  drafts.delete(message.owner); drafts.set(message.owner, backgrounds);
 } else drafts.delete(message.owner);
 const last = [...drafts].at(-1);
 active = last ? { owner: last[0], backgrounds: last[1] } : undefined;
 for (const listener of listeners) listener();
}
if (channel) {
 channel.onmessage = event => { if (event.data && typeof event.data === 'object' && typeof event.data.type === 'string') receive(event.data); };
 channel.postMessage({ type: 'request' });
 window.addEventListener('pagehide', () => { for (const owner of owned) channel.postMessage({ type: 'end', owner }); channel.close(); });
}
export function previewBackgrounds(owner: string, backgrounds: ThemeBackgrounds) {
 owned.add(owner);
 const message = { type: 'preview', owner, backgrounds } as const;
 receive(message); channel?.postMessage(message);
}
export function endBackgroundPreview(owner: string) {
 if (!owned.delete(owner)) return;
 const message = { type: 'end', owner } as const;
 receive(message); channel?.postMessage(message);
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useBackgroundPreview() { return useSyncExternalStore(subscribe, () => active); }
