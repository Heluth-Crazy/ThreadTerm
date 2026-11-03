import { useEffect, useState } from 'react';
import { formatChatDuration } from '../chatPresentation';

export function ChatWorkingIndicator({ startedAt, zh }: { startedAt?: string; zh: boolean }) {
  const start = Date.parse(startedAt ?? '');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [start]);
  return <div className="chat-live-activity" role="status" aria-label={zh ? '正在处理…' : 'Working…'}>
    <span>{zh ? '正在处理' : 'Working'}</span>
    <span className="chat-first-response-dots" aria-hidden="true"><i /><i /><i /></span>
    {Number.isFinite(start) && <span className="chat-live-elapsed" aria-live="off">{formatChatDuration(Math.max(0, now - start), zh)}</span>}
  </div>;
}
