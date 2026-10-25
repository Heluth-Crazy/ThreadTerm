import type { ChatItem } from '@threadterm/protocol';

/** A byte-budgeted transcript page: the runtime never returns more than this wire size. */
export interface ChatPage {
  items: ChatItem[];
  revision: number;
  hasEarlier: boolean;
  nextBefore?: string;
}

/** Stop a whole-transcript walk even if a server keeps claiming older items. */
export const MAX_CHAT_PAGES = 512;
/** Distance from the top that asks for the previous page. */
export const EARLIER_PAGE_THRESHOLD = 96;

/** Earlier pages are prepended; an item that live events already updated wins. */
export function mergeEarlierPage(current: ChatItem[], earlier: ChatItem[]): ChatItem[] {
  const known = new Set(current.map(item => item.id));
  const older = earlier.filter(item => !known.has(item.id));
  return older.length ? [...older, ...current] : current;
}

/** Whole-transcript readers (export) walk newest-to-oldest pages, then restore order. */
export async function loadAllChatPages(read: (before?: string) => Promise<ChatPage>): Promise<ChatItem[]> {
  const pages: ChatItem[][] = [];
  let before: string | undefined;
  for (let index = 0; index < MAX_CHAT_PAGES; index++) {
    const page = await read(before);
    pages.push(page.items);
    if (!page.hasEarlier || !page.nextBefore || page.nextBefore === before) break;
    before = page.nextBefore;
  }
  return pages.reverse().flat();
}

/** Prepending content above the viewport must keep the message being read in place. */
export function anchoredScrollTop(previousTop: number, previousHeight: number, nextHeight: number): number {
  return Math.max(0, previousTop + (nextHeight - previousHeight));
}

export function shouldLoadEarlier(scrollTop: number, hasEarlier: boolean, loading: boolean): boolean {
  return hasEarlier && !loading && scrollTop <= EARLIER_PAGE_THRESHOLD;
}

/** A transcript that still cannot scroll owes the reader its next page: there is
 * nothing to drag, so the wheel alone can never reach the rest of it. A view with
 * no height (a hidden tab) is not being read: it waits for the reader instead of
 * pulling the whole transcript in the background. */
export function needsAnotherPage(scrollHeight: number, clientHeight: number, hasEarlier: boolean, loading: boolean): boolean {
  return hasEarlier && !loading && clientHeight > 0 && scrollHeight <= clientHeight + 1;
}
