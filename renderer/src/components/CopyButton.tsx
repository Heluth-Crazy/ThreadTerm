import { useEffect, useState } from 'react';
import { Icon } from './PrototypeIcon';
import './open-in.css';

/**
 * A small copy button beside a branch name, a path or a hash (owner 2026-11-26: 「某些内容可以方便快捷的复制」). It shows
 * while the pointer is on its row (`copy-host`) or it has keyboard focus, and turns into a check for a moment once
 * the text is on the clipboard. `label` says what it copies, for its hover tip.
 */
export function CopyButton({ text, label, className = '' }: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const timer = window.setTimeout(() => setDone(false), 1200); return () => window.clearTimeout(timer); }, [done]);
  return <button type="button" className={`icon-btn icon-btn-sm copy-btn${done ? ' is-done' : ''} ${className}`.trim()} aria-label={label}
    onClick={event => { event.stopPropagation(); void navigator.clipboard.writeText(text).then(() => setDone(true)); }}>
    <Icon name={done ? 'check' : 'copy'} />
  </button>;
}
