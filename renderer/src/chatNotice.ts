import type { ChatUiState } from '@threadterm/protocol';

type Notice = NonNullable<ChatUiState['notice']>;
type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>;
const dismissed = new Set<string>();

export function noticeDismissalKey(notice: Notice): string {
  return `threadterm.chat.notice.${JSON.stringify([notice.code, notice.version ?? '', notice.feature ?? notice.message])}`;
}

export function noticeWasDismissed(notice: Notice, storage?: NoticeStorage): boolean {
  const key = noticeDismissalKey(notice);
  if (dismissed.has(key)) return true;
  try { return storage?.getItem(key) === 'dismissed'; } catch { return false; }
}

export function rememberNoticeDismissal(notice: Notice, storage?: NoticeStorage): void {
  const key = noticeDismissalKey(notice);
  dismissed.add(key);
  try { storage?.setItem(key, 'dismissed'); } catch { /* Keep the dismissal for this renderer. */ }
}
