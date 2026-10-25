import { useSyncExternalStore } from 'react';
import type { ChatUiState } from '@threadterm/protocol';
import { useTranslation } from '../i18n';
import { noticeWasDismissed, rememberNoticeDismissal } from '../chatNotice';
import { Icon } from './PrototypeIcon';
import './chat-provider-notice.css';

const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', notify);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', notify);
  };
}
function storage() {
  try { return window.localStorage; } catch { return undefined; }
}

export function ChatProviderNotice({ notice, message }: { notice: NonNullable<ChatUiState['notice']>; message: string }) {
  const { locale } = useTranslation();
  const zh = locale === 'zh-CN';
  const hidden = useSyncExternalStore(subscribe, () => noticeWasDismissed(notice, storage()), () => false);
  if (hidden) return null;
  const dismiss = zh ? '关闭' : 'Dismiss';
  return <div className="chat-repair-notice chat-provider-notice" role="status"><span>{message}</span><button type="button" className="icon-btn icon-btn-sm" aria-label={dismiss} title={dismiss} onClick={() => { rememberNoticeDismissal(notice, storage()); notify(); }}><Icon name="close" /></button></div>;
}
