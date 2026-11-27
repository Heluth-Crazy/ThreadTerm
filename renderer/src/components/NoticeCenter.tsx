import { CopyButton } from './CopyButton';
import { useEffect, useRef, useState } from 'react';
import { dismissNotice, useNotices, type Notice } from '../notices';
import { usePassiveBrowserOcclusion } from '../browserOcclusion';
import './notice-center.css';

/**
 * The app's floating notices, bottom right (owner 11-25: errors as pop-ups, not bars inside the page). A notice
 * closes by its close button, after its time (paused while the pointer is on it), or when its cause is gone.
 */
export function NoticeCenter({ zh }: { zh: boolean }) {
  const notices = useNotices();
  if (!notices.length) return null;
  return <div className="tt-notices" aria-label={zh ? '通知' : 'Notifications'}>
    {notices.map(notice => <NoticeRow key={notice.key} notice={notice} zh={zh} />)}
  </div>;
}

function NoticeRow({ notice, zh }: { notice: Notice; zh: boolean }) {
  const [held, setHeld] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  // A notice over a native browser page swaps the page for its snapshot, so the notice is not hidden behind it.
  usePassiveBrowserOcclusion(row);
  useEffect(() => {
    if (!notice.ttlMs || held) return;
    const timer = window.setTimeout(() => dismissNotice(notice.key), notice.ttlMs);
    return () => window.clearTimeout(timer);
  }, [notice.id, notice.key, notice.ttlMs, held]);
  return <div ref={row} className={`toast tt-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}
    aria-live={notice.tone === 'error' ? 'assertive' : 'polite'} onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}
    onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
    <i className="tt-notice-mark" aria-hidden="true" />
    <p className="tt-notice-text">{notice.text}</p>
    {notice.tone === 'error' && <CopyButton className="tt-notice-copy" text={notice.text} label={zh ? '复制错误信息' : 'Copy error text'} />}
    <button type="button" className="tt-notice-close" aria-label={zh ? '关闭' : 'Dismiss'} title={zh ? '关闭' : 'Dismiss'} onClick={() => dismissNotice(notice.key)}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
    </button>
  </div>;
}
