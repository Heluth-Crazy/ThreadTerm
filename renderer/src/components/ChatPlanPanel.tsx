import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatItem, ChatPlanEntry } from '@threadterm/protocol';
import { latestPlan, planEntryLabel, planPriorityLabel, planProgress, shouldAutoOpenPlan } from '../chatPlan';
import './chat-plan.css';

type Copy = (en: string, zh: string) => string;

function StatusMark({ status, active }: { status: ChatPlanEntry['status']; active: boolean }) {
  if (status === 'completed') return <span className="chat-plan-mark is-done" aria-hidden="true">✓</span>;
  if (status === 'in_progress') return active
    ? <span className="chat-plan-mark is-active" aria-hidden="true"><i /></span>
    : <span className="chat-plan-mark is-active-static" aria-hidden="true">◐</span>;
  return <span className="chat-plan-mark is-pending" aria-hidden="true">○</span>;
}

/**
 * The pinned agent-plan chip (B4). It shows the newest plan part in the
 * transcript, opens once when a live turn first writes a plan, and renders
 * nothing at all when no plan exists.
 */
export function ChatPlanPanel({ items, copy, liveTurnId, historyReady = true, navigation }: { items: readonly ChatItem[]; copy: Copy; liveTurnId?: string; historyReady?: boolean; navigation?: ReactNode }) {
  const plan = useMemo(() => latestPlan(items), [items]);
  const [open, setOpen] = useState(false);
  const autoOpened = useRef(false);
  const previousPlan = useRef(plan);
  const wasHistoryReady = useRef(historyReady);

  useEffect(() => {
    const shouldOpen = shouldAutoOpenPlan(plan, previousPlan.current, autoOpened.current, historyReady && wasHistoryReady.current);
    previousPlan.current = plan;
    wasHistoryReady.current = historyReady;
    if (shouldOpen) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [plan, historyReady]);

  if (!plan) return navigation ? <div className="chat-plan-panel"><div className="chat-plan-sticky">{navigation}</div></div> : null;
  const entries = plan.data.entries;
  const { done, total } = planProgress(entries);
  const percent = total ? Math.round((done / total) * 100) : 0;
  const active = Boolean(liveTurnId && plan.turnId && plan.turnId === liveTurnId);
  const label = copy(`Plan ${done}/${total}`, `计划 ${done}/${total}`);
  const title = entries.map(entry => planEntryLabel(entry, copy)).join('\n');

  return <div className="chat-plan-panel" onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      setOpen(false);
    }
  }}>
    <div className="chat-plan-sticky">
      <button type="button" className="chip chip-btn chat-plan-chip" aria-expanded={open} aria-label={label} title={title} onClick={() => setOpen(current => !current)}>
        <span className="chat-plan-label">{label}</span>
        <span className="chat-plan-progress" role="presentation"><i style={{ width: `${percent}%` }} /></span>
      </button>
      {navigation}
    </div>
    {open && <div className="chat-plan-card" role="group" aria-label={copy('Agent plan', '代理计划')}>
      {plan.data.explanation && <p className="chat-plan-explanation">{plan.data.explanation}</p>}
      <ol className="chat-plan-list">
        {entries.map((entry, index) => <li className={`chat-plan-entry is-${entry.status}`} key={index} title={planEntryLabel(entry, copy)}>
          <StatusMark status={entry.status} active={active} />
          <span className="chat-plan-entry-text">{entry.content}</span>
          {entry.priority && <span className={`chip flat chat-plan-priority is-${entry.priority}`}>{planPriorityLabel(entry.priority, copy)}</span>}
        </li>)}
      </ol>
    </div>}
  </div>;
}
