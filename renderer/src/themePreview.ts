import { customTokens, setThemePreview, type ThemeTokens } from './themes';

type PreviewMessage = { type: 'preview'; owner: string; tokens: ThemeTokens } | { type: 'end'; owner: string } | { type: 'request' };
let active: { owner: string; tokens: ThemeTokens } | undefined;
const drafts = new Map<string, ThemeTokens>();
const owned = new Set<string>();
const channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('threadterm-appearance-preview') : undefined;
function receive(message: PreviewMessage) {
  if (message.type === 'request') {
    if (active && owned.has(active.owner)) channel?.postMessage({ type: 'preview', ...active });
  } else if (message.type === 'preview' && typeof message.owner === 'string') {
    const tokens = customTokens(message.tokens);
    if (!tokens) return;
    drafts.delete(message.owner);
    drafts.set(message.owner, tokens);
    active = { owner: message.owner, tokens };
    setThemePreview(tokens);
  } else if (message.type === 'end') {
    drafts.delete(message.owner);
    if (active?.owner === message.owner) {
      const previous = [...drafts].at(-1);
      active = previous ? { owner: previous[0], tokens: previous[1] } : undefined;
      setThemePreview(active?.tokens);
    }
  }
}
if (channel) {
  channel.onmessage = event => { if (event.data && typeof event.data === 'object') receive(event.data); };
  channel.postMessage({ type: 'request' });
  window.addEventListener('pagehide', () => { for (const owner of owned) channel.postMessage({ type: 'end', owner }); channel.close(); });
}
export function previewColors(owner: string, tokens: ThemeTokens): void {
  owned.add(owner);
  const message = { type: 'preview', owner, tokens } as const;
  receive(message);
  channel?.postMessage(message);
}
export function endColorPreview(owner: string): void {
  owned.delete(owner);
  const message = { type: 'end', owner } as const;
  receive(message);
  channel?.postMessage(message);
}
