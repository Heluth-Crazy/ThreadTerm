import { useEffect, useRef, useState, type ReactNode } from 'react';

type Copy = (en: string, zh: string) => string;

/**
 * Hover and focus action bar for one completed assistant reply. It is the
 * anchor for later reply actions (for example "Fork from here"), which are
 * passed as children. The copied label lives for 1.5 s and its timer exists
 * only while the label shows.
 */
export function MessageActions({ markdown, copy, children }: { markdown: string; copy: Copy; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (timer.current !== undefined) window.clearTimeout(timer.current); }, []);
  const onCopy = () => {
    void navigator.clipboard.writeText(markdown).then(() => {
      setCopied(true);
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => { timer.current = undefined; setCopied(false); }, 1500);
    }).catch(() => undefined);
  };
  return <div className="chat-message-actions" role="group" aria-label={copy('Message actions', '消息操作')}>
    <button type="button" className="chat-message-action" onClick={onCopy} aria-live="polite">{copied ? copy('Copied', '已复制') : copy('Copy', '复制')}</button>
    {children}
  </div>;
}
