import { useState } from 'react';
import { delegationQuietLabel } from '../delegation';
import { useVisibleTicker } from '../visibleTicker';

type Copy = (en: string, zh: string) => string;

/**
 * R6: a quiet delegate's minutes, ticking in this one small component so no
 * transcript or card around it re-renders. The text comes from the runtime's
 * `lastActivityAt`; there is no local quiet rule here.
 */
export function QuietMinutes({ since, copy, className }: { since: string; copy: Copy; className?: string }) {
  const [now, setNow] = useState(Date.now);
  useVisibleTicker(() => setNow(Date.now()), true);
  return <span className={`delegate-quiet${className ? ` ${className}` : ''}`} aria-live="off">{delegationQuietLabel(since, copy, now)}</span>;
}
