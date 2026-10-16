/** Pure policy helpers. Keep them independent of Electron for cheap regression tests. */
export type BrowserPreferences = { unloadAfterMinutes: number; linkTarget: 'builtin'|'system' };
export const defaultBrowserPreferences: BrowserPreferences = { unloadAfterMinutes: 10, linkTarget: 'builtin' };

export function normalizeBrowserUrl(value: unknown): { url?: string; issue?: string } {
  if (typeof value !== 'string') return { issue: 'Enter a web address.' };
  const text = value.trim();
  if (!text) return { issue: 'Enter a web address.' };
  // A bare word is not a hostname: it is usually a search query, and this browser deliberately has no search engine.
  const host = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\]|[a-z\d-]+(?:\.[a-z\d-]+)+)(?::\d{1,5})?(?:[/?#].*)?$/i;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^about:blank$/i.test(text) ? text : (host.test(text) && !/\s/.test(text) ? `https://${text}` : '');
  if (!candidate) return { issue: 'Enter an http or https address; search is not available here.' };
  try {
    const url = new URL(candidate);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'about:' && url.pathname === 'blank') return { url: url.href };
    return { issue: `Blocked address: ${url.protocol}` };
  } catch { return { issue: 'That address is not valid.' }; }
}

export function allowedTopLevelUrl(value: string, pageOrigin?: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'about:' && url.pathname === 'blank') return true;
    return url.protocol === 'blob:' && !!pageOrigin && url.origin === pageOrigin && /^https?:$/.test(new URL(pageOrigin).protocol);
  } catch { return false; }
}

export function lruVictims<T extends { id: string; visible: boolean; shownAt: number }>(tabs: Iterable<T>, maximum: number): string[] {
  const all = [...tabs], live = all.filter(tab => !tab.visible).sort((a,b) => a.shownAt - b.shownAt || a.id.localeCompare(b.id));
  return live.slice(0, Math.max(0, all.length - maximum)).map(tab => tab.id);
}

export function expiredHidden<T extends { id: string; visible: boolean; hiddenAt?: number }>(tabs: Iterable<T>, now: number, minutes: number): string[] {
  if (minutes <= 0) return [];
  const cutoff = now - minutes * 60_000;
  return [...tabs].filter(tab => !tab.visible && tab.hiddenAt !== undefined && tab.hiddenAt <= cutoff).map(tab => tab.id);
}

export function leaseCount(current: number, active: boolean): number { return Math.max(0, current + (active ? 1 : -1)); }
