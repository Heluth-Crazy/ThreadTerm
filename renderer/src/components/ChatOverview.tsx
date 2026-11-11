import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatItem, ChatPlanEntry, Session } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { attachedMessagesLabel, authorityLabel, delegationActive } from '../delegation';
import {
  OVERVIEW_COLLAPSED_KEY, OVERVIEW_FINISHED_OPEN_KEY, overviewChangesFileCount, overviewChangesLabel,
  overviewDelegateGroups, overviewFinishedLabel, overviewHasSections, overviewPlan, overviewPlanText,
  overviewStateText, readOverviewCollapsed, readOverviewFinishedOpen, toggleOverviewFinishedOpen, type Copy,
} from '../chatOverview';
import { planEntryLabel, planPriorityLabel } from '../chatPlan';
import { AgentIcon, Icon } from './PrototypeIcon';
import { SurfaceActions } from './SessionSurfaceContext';
import './chat-plan.css';
import './chat-overview.css';

function readCollapsed(): boolean {
  try { return readOverviewCollapsed(localStorage.getItem(OVERVIEW_COLLAPSED_KEY)); } catch { return false; }
}
function readFinishedOpen(): string[] {
  try { return readOverviewFinishedOpen(localStorage.getItem(OVERVIEW_FINISHED_OPEN_KEY)); } catch { return []; }
}
function persist(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* keep the in-memory choice when storage is unavailable */ }
}
function openAgentChanges(): void {
  const key = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
  window.dispatchEvent(new CustomEvent('threadterm:workbench', { detail: { view: 'changes', key } }));
}

function PlanMark({ status, live }: { status: ChatPlanEntry['status']; live: boolean }) {
  if (status === 'completed') return <span className="chat-plan-mark is-done" aria-hidden="true">✓</span>;
  if (status === 'in_progress') return live
    ? <span className="chat-plan-mark is-active" aria-hidden="true"><i /></span>
    : <span className="chat-plan-mark is-active-static" aria-hidden="true">◐</span>;
  return <span className="chat-plan-mark is-pending" aria-hidden="true">○</span>;
}

/**
 * The Chat overview (variant A): delegated agents, changes and the agent plan in
 * one card that docks in the empty gutter when it fits and collapses into a
 * header button otherwise. Nothing is rendered above the transcript.
 */
export function ChatOverview({ session, delegates, items, copy, zh, docked, liveTurnId, onOpenSession, onOpenChanges, navigation }: {
  session: Session;
  delegates: readonly Session[];
  items: readonly ChatItem[];
  copy: Copy;
  zh: boolean;
  docked: boolean;
  liveTurnId?: string;
  onOpenSession?: (sessionId: string) => void;
  onOpenChanges?: () => void;
  navigation?: ReactNode;
}) {
  const popoverId = useId(), finishedId = useId(), planId = useId();
  const now = Date.now();
  const groups = useMemo(() => overviewDelegateGroups(delegates, now), [delegates, now]);
  const plan = useMemo(() => overviewPlan(items), [items]);
  const changes = useMemo(() => overviewChangesFileCount(items), [items]);
  const planActive = Boolean(plan?.turnId && liveTurnId && plan.turnId === liveTurnId);
  const hasSections = overviewHasSections({ delegates, plan, changes });
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [finishedOpen, setFinishedOpen] = useState<string[]>(readFinishedOpen);
  const [open, setOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const showDocked = docked && !collapsed && hasSections;
  const showButton = !showDocked && hasSections;
  const activeCount = groups.active.length;
  const buttonLabel = activeCount
    ? copy(`${activeCount} running`, `${activeCount} 个进行中`)
    : copy('Delegated agents', '委派的代理');
  const accessibleLabel = `${buttonLabel}${groups.badge ? copy(`, ${groups.badge} need you`, `，${groups.badge} 个待处理`) : ''}`;
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  useEffect(() => { if (showDocked && open) setOpen(false); }, [showDocked, open]);

  const expand = () => {
    if (docked && collapsed) {
      setCollapsed(false);
      persist(OVERVIEW_COLLAPSED_KEY, '0');
      return;
    }
    setOpen(value => !value);
  };
  const collapse = () => {
    setOpen(false);
    setCollapsed(true);
    persist(OVERVIEW_COLLAPSED_KEY, '1');
  };
  const toggleFinished = () => {
    const next = !finishedOpen.includes(session.id);
    const ids = toggleOverviewFinishedOpen(finishedOpen, session.id, next);
    setFinishedOpen(ids);
    persist(OVERVIEW_FINISHED_OPEN_KEY, JSON.stringify(ids));
  };
  const finished = overviewFinishedLabel(groups.finished.length, groups.failedFinished, copy);
  const showFinished = finishedOpen.includes(session.id);
  const openChanges = onOpenChanges ?? openAgentChanges;

  const card = <div className={`chat-overview-card${showDocked ? ' is-docked' : ''}`} aria-label={copy('Chat overview', '聊天概览')}>
    {showDocked && <button type="button" className="icon-btn chat-overview-collapse" aria-label={copy('Collapse overview', '收起概览')} title={copy('Collapse overview', '收起概览')} onClick={collapse}><Icon name="back" /></button>}
    {delegates.length > 0 && <section className="chat-overview-section" aria-label={copy('Delegated agents', '委派的代理')}>
      <div className="chat-overview-section-head"><span>{copy('Delegated agents', '委派的代理')}</span><span className="chat-overview-count">{groups.active.length ? copy(`${groups.active.length} active`, `${groups.active.length} 个进行中`) : finished.label}</span></div>
      {groups.active.map(delegate => <OverviewDelegateRow key={delegate.id} delegate={delegate} copy={copy} zh={zh} now={now} onOpen={onOpenSession} />)}
      {groups.finished.length > 0 && <>
        <div className="chat-overview-fold">
          <button type="button" className="chat-overview-fold-button" aria-expanded={showFinished} aria-controls={finishedId} onClick={toggleFinished}>
            <Icon name={showFinished ? 'chevD' : 'chevR'} />
            <span className="chat-overview-row-title">{finished.label}</span>
          </button>
          {finished.failed && <span className="chat-overview-fold-failed">{finished.failed}</span>}
        </div>
        {showFinished && <div id={finishedId}>{groups.finished.map(delegate => <OverviewDelegateRow key={delegate.id} delegate={delegate} copy={copy} zh={zh} now={now} onOpen={onOpenSession} />)}</div>}
      </>}
    </section>}
    {changes !== undefined && <section className="chat-overview-section" aria-label={copy('Changes', '变更')}>
      <button type="button" className="chat-overview-changes" onClick={() => { close(); openChanges(); }}>
        <span className="chat-overview-changes-label">{copy('Changes', '变更')}</span>
        <span className="chat-overview-changes-count">{overviewChangesLabel(changes, copy)}</span>
        <Icon name="chevR" />
      </button>
    </section>}
    {plan && <section className="chat-overview-section" aria-label={copy('Plan', '计划')}>
      <div className="chat-overview-section-head"><span>{copy('Plan', '计划')}</span><span className="chat-overview-count">{plan.done}/{plan.total}</span></div>
      <button type="button" className="chat-overview-plan" aria-expanded={planOpen} aria-controls={planId} title={plan.entries.map(entry => planEntryLabel(entry, copy)).join('\n')} onClick={() => setPlanOpen(value => !value)}>
        <span className="chat-overview-plan-bar" role="presentation"><i style={{ width: `${plan.percent}%` }} /></span>
        <span className="chat-overview-plan-text">{overviewPlanText(plan, copy)}</span>
        <Icon name={planOpen ? 'chevD' : 'chevR'} />
      </button>
      {planOpen && <div id={planId} className="chat-overview-plan-list" role="group" aria-label={copy('Agent plan', '代理计划')}>
        {plan.explanation && <p className="chat-plan-explanation">{plan.explanation}</p>}
        <ol className="chat-plan-list">
          {plan.entries.map((entry, index) => <li className={`chat-plan-entry is-${entry.status}`} key={index} title={planEntryLabel(entry, copy)}>
            <PlanMark status={entry.status} live={planActive} />
            <span className="chat-plan-entry-text">{entry.content}</span>
            {entry.priority && <span className={`chip flat chat-plan-priority is-${entry.priority}`}>{planPriorityLabel(entry.priority, copy)}</span>}
          </li>)}
        </ol>
      </div>}
    </section>}
  </div>;

  return <>
    {(navigation || showButton) && <SurfaceActions slot="primary"><div className="chat-overview-header" ref={root}>
      {navigation}
      {showButton && <button ref={trigger} type="button" className={`chat-overview-button${open ? ' open' : ''}`} aria-expanded={open} aria-controls={popoverId} aria-label={accessibleLabel} title={accessibleLabel} onClick={expand}>
        <span className="chat-overview-stack" aria-hidden="true">
          {groups.active.length
            ? groups.active.slice(0, 4).map(delegate => <AgentIcon key={delegate.id} provider={delegate.provider} size={16} />)
            : <Icon name="agents" />}
        </span>
        <span className="chat-overview-button-label">{buttonLabel}</span>
        {groups.badge > 0 && <span className="chat-overview-badge" aria-hidden="true">{groups.badge > 99 ? '99+' : groups.badge}</span>}
      </button>}
      {open && !showDocked && <div id={popoverId} className="chat-overview-popover" role="dialog" aria-label={copy('Chat overview', '聊天概览')}>{card}</div>}
    </div></SurfaceActions>}
    {showDocked && <div className="chat-overview-dock">{card}</div>}
  </>;
}

function OverviewDelegateRow({ delegate, copy, zh, now, onOpen }: {
  delegate: Session; copy: Copy; zh: boolean; now: number; onOpen?: (sessionId: string) => void;
}) {
  const state = delegate.delegation!.state;
  const status = overviewStateText(delegate, copy, now);
  const [issue, setIssue] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const delegation = delegate.delegation!;
  const attached = delegation.userMessages ? attachedMessagesLabel(delegation.userMessages, copy) : undefined;
  const title = [
    delegate.title,
    delegation.branch ? copy(`Branch: ${delegation.branch}`, `分支：${delegation.branch}`) : undefined,
    delegation.authority ? copy(`Access: ${authorityLabel(delegation.authority, copy)}`, `权限：${authorityLabel(delegation.authority, copy)}`) : undefined,
    attached?.label,
    delegation.outcome,
  ].filter(Boolean).join('\n');
  const stop = () => {
    setStopping(true);
    setIssue(undefined);
    void request('session.stop', { sessionId: delegate.id, operationId: operationId() })
      .catch(error => setIssue(error instanceof Error ? error.message : String(error)))
      .finally(() => setStopping(false));
  };
  return <div className={`chat-overview-row is-${status.tone}`} data-session-id={delegate.id} data-state={state}>
    <button type="button" className="chat-overview-row-open" title={title} aria-label={copy(`Open ${delegate.title}, ${status.text}`, `打开 ${delegate.title}，${status.text}`)} onClick={() => onOpen?.(delegate.id)}>
      <AgentIcon provider={delegate.provider} size={16} />
      <span className="chat-overview-row-title">{delegate.title}</span>
      <span className={`chat-overview-state is-${status.tone}${issue ? ' is-error' : ''}`} role={issue ? 'alert' : undefined} title={issue ?? status.text}>{issue ? copy('Stop failed', '停止失败') : status.text}</span>
      <span className="chat-overview-open-hint">{copy('Open', '打开')}</span>
    </button>
    {delegationActive(state) && <button type="button" className="chat-overview-stop" disabled={stopping} onClick={stop}>{stopping ? copy('Stopping…', '停止中…') : copy('Stop', '停止')}</button>}
  </div>;
}
