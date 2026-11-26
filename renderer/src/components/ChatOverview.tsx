import { lazy, Suspense, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatItem, ChatPlanEntry, NativeSubagentSummary, ReviewFile, Session } from '@threadterm/protocol';
import { operationId, request, subscribeEvents } from '../bridge';
import { attachedMessagesLabel, authorityLabel, delegationActive, delegationStateLabel } from '../delegation';
import {
  OVERVIEW_COLLAPSED_KEY, OVERVIEW_FINISHED_OPEN_KEY, overviewBranchHead, overviewBranchName,
  overviewChangeKindLabel, overviewChangeRowLabel, overviewChangesLabel, overviewCompareStat,
  overviewDelegateGroups, overviewFinishedLabel, overviewHasSections, overviewPlan, overviewPlanText,
  overviewReviewStat, overviewSessionCheckpoint, overviewStateText, overviewTurnChanges,
  readOverviewCollapsed, readOverviewFinishedOpen, toggleOverviewFinishedOpen, type Copy, type OverviewChangeStat,
} from '../chatOverview';
import { branchScopeKey, readBranchScopePreference } from '../workbench/branchScope';
import { createRefreshQueue } from '../workbench/refreshQueue';
import { eventTouchesWorktree } from '../workbench/refreshTriggers';
import { FILES_CHANGED_EVENT, scopeParams } from '../workbench/types';
import { useNativeSubagents } from '../nativeSubagents';
import { subagentTitle } from '../subagentActivity';
import { planEntryLabel, planPriorityLabel } from '../chatPlan';
import { createTurnChangesCache } from '../turnFooter';
import { AgentTile, Icon } from './PrototypeIcon';
import { ContextHost } from './ContextHost';
import { QuietMinutes } from './QuietMinutes';
import { SurfaceDialog } from './SurfaceDialog';
import { SessionSurfaceContext, SurfaceActions } from './SessionSurfaceContext';
import './chat-plan.css';
import './chat-overview.css';

const ReviewDiffView = lazy(async () => ({ default: (await import('./ReviewDiffView')).ReviewDiffView }));

type OpenTurnReview = {
  sessionId: string;
  projectId: string;
  worktreePath?: string;
  from: string;
  to: string;
  title: string;
  readFiles: () => Promise<ReviewFile[]>;
};

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

/** R5: the workbench Source Control view in branch scope, switched by `SourceControlView` itself. */
function openBranchScope(): void {
  const key = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
  window.dispatchEvent(new CustomEvent('threadterm:workbench', { detail: { view: 'scm', key, scope: 'branch' } }));
}

type OverviewBranchRow = { stat: OverviewChangeStat; name?: string; base?: string; committedOnly: boolean };

type OverviewChangeRows = {
  /** The session these numbers belong to; another session's rows are never shown. */
  sessionId: string;
  loaded: boolean;
  session?: OverviewChangeStat;
  branch?: OverviewBranchRow;
};

/** R2: the oldest ready checkpoint against the current files; any failure hides the row silently. */
async function loadSessionChangeStat(sessionId: string): Promise<OverviewChangeStat | undefined> {
  try {
    const state = await request('review.list', { sessionId });
    const from = state.available ? overviewSessionCheckpoint(state.checkpoints) : undefined;
    if (!from) return undefined;
    return overviewReviewStat((await request('review.changes', { sessionId, from: from.id })).files);
  } catch { return undefined; }
}

/** R2: `git.compare.files` with the base and scope Source Control remembers, so both read the same numbers. */
async function loadBranchRow(scope: { projectId: string; worktreePath?: string }): Promise<OverviewBranchRow | undefined> {
  const preference = readBranchScopePreference(branchScopeKey(scope)), params = scopeParams(scope);
  const [status, compare] = await Promise.all([
    request('git.status', params).catch(() => undefined),
    request('git.compare.files', {
      ...params,
      ...(preference?.base ? { base: preference.base } : {}),
      ...(preference?.committedOnly ? { committedOnly: true } : {}),
    }).catch(() => undefined),
  ]);
  if (!compare) return undefined;
  const name = overviewBranchName(status?.branch, compare.head);
  return {
    stat: overviewCompareStat(compare.files),
    ...(name ? { name } : {}),
    base: compare.base.ref,
    committedOnly: Boolean(preference?.committedOnly),
  };
}

/**
 * R3: the card loads its two rows only while it is on screen, and refreshes from the same events as
 * Agent Changes. The last numbers stay while a refresh runs, and an answer for a session the card no
 * longer shows is dropped.
 */
function useOverviewChangeRows(session: Session, delegateIds: readonly string[], visible: boolean): OverviewChangeRows {
  const [rows, setRows] = useState<OverviewChangeRows>(() => ({ sessionId: session.id, loaded: false }));
  const generation = useRef(0);
  const ids = useRef(delegateIds);
  ids.current = delegateIds;
  const { id: sessionId, projectId, worktreePath } = session;
  const load = useCallback(async () => {
    const ticket = ++generation.current;
    const [sessionRow, branchRow] = await Promise.all([
      loadSessionChangeStat(sessionId),
      projectId ? loadBranchRow({ projectId, ...(worktreePath ? { worktreePath } : {}) }) : undefined,
    ]);
    if (ticket !== generation.current) return;
    setRows({
      sessionId, loaded: true,
      ...(sessionRow ? { session: sessionRow } : {}),
      ...(branchRow ? { branch: branchRow } : {}),
    });
  }, [sessionId, projectId, worktreePath]);
  useEffect(() => {
    // A stale answer for another session must not land on this card.
    generation.current += 1;
    setRows(current => current.sessionId === sessionId ? current : { sessionId, loaded: false });
    if (!visible) return;
    const queue = createRefreshQueue(load);
    void queue.request();
    const changed = () => { void queue.request(); };
    const shown = () => { if (document.visibilityState === 'visible') changed(); };
    addEventListener(FILES_CHANGED_EVENT, changed);
    document.addEventListener('visibilitychange', shown);
    const workspace = { projectId: projectId ?? '', ...(worktreePath ? { worktreePath } : {}) };
    const unsubscribe = subscribeEvents(event => {
      if (eventTouchesWorktree(event, workspace, new Set([sessionId, ...ids.current]))) changed();
    });
    return () => {
      queue.stop();
      removeEventListener(FILES_CHANGED_EVENT, changed);
      document.removeEventListener('visibilitychange', shown);
      unsubscribe();
    };
  }, [visible, load, sessionId, projectId, worktreePath]);
  return rows;
}

/** R1: one 变更 row — icon, label, the diff stat and a chevron, 28 px like every other row. */
function ChangeRow({ kind, stat, copy, onClick, previous }: {
  kind: 'turn' | 'session' | 'branch';
  stat: { files: number; added?: number; removed?: number };
  copy: Copy;
  onClick: () => void;
  previous?: boolean;
}) {
  const label = overviewChangeRowLabel(kind, stat, copy, previous);
  return <button type="button" className={`chat-overview-change is-${kind}`} aria-label={label} aria-haspopup={kind === 'turn' ? 'dialog' : undefined} title={label} onClick={onClick}>
    <Icon name={kind === 'turn' ? 'diff' : kind === 'session' ? 'msg' : 'branch'} className="chat-overview-change-icon" />
    <span className="chat-overview-change-label">{overviewChangeKindLabel(kind, copy, previous)}</span>
    <span className="chat-overview-stat">
      <span className="chat-overview-stat-files">{overviewChangesLabel(stat.files, copy)}</span>
      {stat.added !== undefined && <span className={`chat-overview-stat-add${stat.added ? '' : ' is-zero'}`}>+{stat.added}</span>}
      {stat.removed !== undefined && <span className={`chat-overview-stat-del${stat.removed ? '' : ' is-zero'}`}>−{stat.removed}</span>}
    </span>
    <Icon name="chevR" className="chat-overview-change-chevron" />
  </button>;
}

function PlanMark({ status, live }: { status: ChatPlanEntry['status']; live: boolean }) {
  if (status === 'completed') return <span className="chat-plan-mark is-done" aria-hidden="true">✓</span>;
  if (status === 'in_progress') return live
    ? <span className="chat-plan-mark is-active" aria-hidden="true"><i /></span>
    : <span className="chat-plan-mark is-active-static" aria-hidden="true">◐</span>;
  return <span className="chat-plan-mark is-pending" aria-hidden="true">○</span>;
}

/**
 * The Chat overview: delegated agents, changes, the agent plan, and the session's message list and task map in
 * one card. Owner 11-24 (after T3 Code's thread details card): in a wide Chat the card docks in the empty gutter
 * and collapses into a chip in the same corner; in a narrow Chat it opens from the header button. A Chat with
 * nothing but messages gets a small pill with the message list and the task map. Nothing goes above the transcript.
 */
export function ChatOverview({ session, delegates, items, copy, zh, docked, liveTurnId, onOpenSession, onOpenChanges, navigation, onOpenTaskMap }: {
  session: Session;
  delegates: readonly Session[];
  items: readonly ChatItem[];
  copy: Copy;
  zh: boolean;
  docked: boolean;
  liveTurnId?: string;
  onOpenSession?: (sessionId: string) => void;
  onOpenChanges?: () => void;
  /** The message list: a card row, or a compact button in the pill. Absent below three messages. */
  navigation?: (variant: 'row' | 'chip') => ReactNode;
  onOpenTaskMap?: () => void;
}) {
  const popoverId = useId(), finishedId = useId(), planId = useId();
  const now = Date.now();
  const groups = useMemo(() => overviewDelegateGroups(delegates, now), [delegates, now]);
  const native = useNativeSubagents(session.id);
  const nativeRunning = native.filter(agent => agent.status === 'running');
  const nativeFinished = native.filter(agent => agent.status !== 'running');
  const plan = useMemo(() => overviewPlan(items), [items]);
  const turnChanges = useMemo(() => overviewTurnChanges(items, liveTurnId), [items, liveTurnId]);
  const turn = session.projectId ? turnChanges : undefined;
  const turnKey = turn ? JSON.stringify([session.id, turn.review.from, turn.review.to]) : undefined;
  // A fixed comparison doesn't change when the worktree does. Keep only the latest list for this card.
  const turnFiles = useMemo(() => createTurnChangesCache<{ files: ReviewFile[]; stat: OverviewChangeStat }>(), [turnKey]);
  const latestTurnKey = useRef(turnKey);
  latestTurnKey.current = turnKey;
  const [turnSummary, setTurnSummary] = useState<{ key: string; stat: OverviewChangeStat }>();
  const [review, setReview] = useState<OpenTurnReview>();
  const surface = useContext(SessionSurfaceContext);
  const comments = useContext(ContextHost);
  const visible = surface ? surface.actionsVisible ?? surface.focused : true;
  const showReview = visible && review?.sessionId === session.id && review.projectId === session.projectId;
  useEffect(() => { if (!showReview) setReview(undefined); }, [showReview]);
  const planActive = Boolean(plan?.turnId && liveTurnId && plan.turnId === liveTurnId);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [finishedOpen, setFinishedOpen] = useState<string[]>(readFinishedOpen);
  const [open, setOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  // R3: the card asks for its numbers only while it is on screen (docked, or the open popover) and has
  // a reason to exist. Without one — no delegates, subagents, plan or session changes — a Chat must not
  // run `git.status` and `git.compare.files` on every file event just to keep an invisible card current.
  const cardWanted = delegates.length > 0 || native.length > 0 || Boolean(plan) || Boolean(turnChanges);
  const changeRows = useOverviewChangeRows(session, delegates.map(delegate => delegate.id), cardWanted && ((docked && !collapsed) || open));
  const sessionChanges = changeRows.session && changeRows.session.files > 0 ? changeRows.session : undefined;
  const branchChanges = changeRows.branch && changeRows.branch.stat.files > 0 ? changeRows.branch : undefined;
  // A turn can undo earlier edits, so its row survives an empty cumulative comparison.
  const changesPresent = Boolean(turn || sessionChanges || (!changeRows.loaded && turnChanges));
  const hasSections = native.length > 0 || overviewHasSections({ delegates, plan, changes: changesPresent ? 1 : 0 });
  const hasSessionSection = Boolean(navigation || onOpenTaskMap);
  const showDocked = docked && !collapsed && hasSections;
  // Owner 11-24: collapsing a docked card leaves a chip in its corner, never a header control.
  const showChip = docked && collapsed && hasSections;
  const showMini = docked && !hasSections && hasSessionSection;
  const showButton = !docked && (hasSections || hasSessionSection);
  const branchHead = branchChanges
    ? overviewBranchHead({ ...(changeRows.branch?.name ? { branch: changeRows.branch.name } : {}), ...(changeRows.branch?.base ? { base: changeRows.branch.base } : {}), committedOnly: Boolean(changeRows.branch?.committedOnly) }, copy)
    : undefined;
  const activeCount = groups.active.length + nativeRunning.length;
  // With the plan tools on and the change rows, a Chat without delegates gets the card too: name it
  // for what it holds then, not for delegates it never had.
  const buttonLabel = activeCount
    ? copy(`${activeCount} running`, `${activeCount} 个进行中`)
    : delegates.length > 0 || native.length > 0
      ? copy('Delegated agents', '委派的代理')
      : copy('Overview', '概览');
  const turnPreview = turn && copy(
    `${turn.previous ? 'Last' : 'Turn'} · ${overviewChangesLabel(turn.review.fileCount, copy)}`,
    `${turn.previous ? '上次改动' : '本轮'} ${overviewChangesLabel(turn.review.fileCount, copy)}`,
  );
  const accessibleLabel = `${buttonLabel}${turnPreview ? `, ${turnPreview}` : ''}${groups.badge ? copy(`, ${groups.badge} need you`, `，${groups.badge} 个待处理`) : ''}`;
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const openTurnReview = () => {
    if (!turn || turnKey === undefined || !session.projectId) return;
    const { from, to } = turn.review;
    const sessionId = session.id;
    close();
    setReview({
      sessionId, projectId: session.projectId, worktreePath: session.worktreePath, from, to,
      title: turn.previous ? copy('Previous changes', '上次改动') : copy('Turn changes', '本轮改动'),
      readFiles: async () => {
        const { files, stat } = await turnFiles.load(turnKey, async () => {
          const result = await request('review.changes', { sessionId, from, to });
          return { files: result.files, stat: overviewReviewStat(result.files) };
        });
        if (latestTurnKey.current === turnKey) setTurnSummary(current => current?.stat === stat ? current : { key: turnKey, stat });
        return files;
      },
    });
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      // The message list opens in a portal; picking from it is not an outside click.
      if (!root.current?.contains(event.target as Node) && !(event.target instanceof Element && event.target.closest('.chat-message-popover'))) close();
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
  const finishedCount = groups.finished.length + nativeFinished.length;
  const failedCount = groups.failedFinished + nativeFinished.filter(agent => agent.status === 'failed').length;
  const finished = overviewFinishedLabel(finishedCount, failedCount, copy);
  const showFinished = finishedOpen.includes(session.id);
  const openChanges = onOpenChanges ?? openAgentChanges;

  const card = <div className={`chat-overview-card${showDocked ? ' is-docked' : ''}`} aria-label={copy('Chat overview', '聊天概览')}>
    {showDocked && <button type="button" className="icon-btn chat-overview-collapse" aria-label={copy('Collapse overview', '收起概览')} title={copy('Collapse overview', '收起概览')} onClick={collapse}><Icon name="minimize" /></button>}
    {(delegates.length > 0 || native.length > 0) && <section className="chat-overview-section" aria-label={copy('Delegated agents', '委派的代理')}>
      <div className="chat-overview-section-head"><span>{copy('Delegated agents', '委派的代理')}</span><span className="chat-overview-count">{activeCount ? copy(`${activeCount} active`, `${activeCount} 个进行中`) : finished.label}</span></div>
      {groups.active.map(delegate => <OverviewDelegateRow key={delegate.id} delegate={delegate} copy={copy} zh={zh} now={now} onOpen={onOpenSession} />)}
      {nativeRunning.map(agent => <OverviewNativeSubagent key={agent.key} agent={agent} copy={copy} zh={zh} />)}
      {finishedCount > 0 && <>
        <div className="chat-overview-fold">
          <button type="button" className="chat-overview-fold-button" aria-expanded={showFinished} aria-controls={finishedId} onClick={toggleFinished}>
            <Icon name={showFinished ? 'chevD' : 'chevR'} />
            <span className="chat-overview-row-title">{finished.label}</span>
          </button>
          {finished.failed && <span className="chat-overview-fold-failed">{finished.failed}</span>}
        </div>
        {showFinished && <div id={finishedId}>
          {groups.finished.map(delegate => <OverviewDelegateRow key={delegate.id} delegate={delegate} copy={copy} zh={zh} now={now} onOpen={onOpenSession} />)}
          {nativeFinished.map(agent => <OverviewNativeSubagent key={agent.key} agent={agent} copy={copy} zh={zh} />)}
        </div>}
      </>}
    </section>}
    {turn || sessionChanges || branchChanges ? <section className="chat-overview-section" aria-label={copy('Changes', '变更')}>
      <div className="chat-overview-section-head">
        <span>{copy('Changes', '变更')}</span>
        {branchHead && <span className="chat-overview-branch-name" title={branchHead.title}>{branchHead.text}</span>}
      </div>
      {turn && <ChangeRow kind="turn" stat={turnSummary && turnSummary.key === turnKey ? turnSummary.stat : { files: turn.review.fileCount }}
        previous={turn.previous} copy={copy} onClick={openTurnReview} />}
      {sessionChanges && <ChangeRow kind="session" stat={sessionChanges} copy={copy} onClick={() => { close(); openChanges(); }} />}
      {branchChanges && <ChangeRow kind="branch" stat={branchChanges.stat} copy={copy} onClick={() => { close(); openBranchScope(); }} />}
    </section> : null}
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
    {hasSessionSection && <section className="chat-overview-section" aria-label={copy('Session', '会话')}>
      <div className="chat-overview-section-head"><span>{copy('Session', '会话')}</span></div>
      {navigation?.('row')}
      {onOpenTaskMap && <button type="button" className="chat-overview-link is-task-map" onClick={() => { close(); onOpenTaskMap(); }}>
        <Icon name="flow" className="chat-overview-change-icon" />
        <span className="chat-overview-change-label">{copy('Task map', '任务图')}</span>
        <Icon name="chevR" className="chat-overview-change-chevron" />
      </button>}
    </section>}
  </div>;

  const buttonContent = <>
    <span className="chat-overview-stack" aria-hidden="true">
      {activeCount
        ? [...groups.active.map(delegate => ({ key: delegate.id, provider: delegate.provider })),
            ...nativeRunning.map(agent => ({ key: `native:${agent.key}`, provider: agent.provider }))]
          .slice(0, 4).map(agent => <AgentTile key={agent.key} provider={agent.provider} size={16} />)
        : <Icon name="agents" />}
    </span>
    <span className="chat-overview-button-label">{buttonLabel}</span>
    {turnPreview && !docked && <span className="chat-overview-turn-preview">{turnPreview}</span>}
    {groups.badge > 0 && <span className="chat-overview-badge" aria-hidden="true">{groups.badge > 99 ? '99+' : groups.badge}</span>}
  </>;

  return <>
    {showButton && <SurfaceActions slot="primary"><div className="chat-overview-header" ref={root}>
      <button ref={trigger} type="button" className={`chat-overview-button${open ? ' open' : ''}`} aria-expanded={open} aria-controls={popoverId} aria-label={accessibleLabel} title={accessibleLabel} onClick={expand}>{buttonContent}</button>
      {open && <div id={popoverId} className="chat-overview-popover" role="dialog" aria-label={copy('Chat overview', '聊天概览')}>{card}</div>}
    </div></SurfaceActions>}
    {showDocked && <div className="chat-overview-dock">{card}</div>}
    {showChip && <div className="chat-overview-dock"><button type="button" className="chat-overview-chip" aria-label={accessibleLabel} title={copy('Expand overview', '展开概览')} onClick={expand}>{buttonContent}</button></div>}
    {showMini && <div className="chat-overview-dock"><div className="chat-overview-mini" role="group" aria-label={copy('Chat overview', '聊天概览')}>
      {navigation?.('chip')}
      {onOpenTaskMap && <button type="button" className="chat-overview-mini-button" aria-label={copy('Task map', '任务图')} onClick={onOpenTaskMap}><Icon name="flow" />{copy('Task map', '任务图')}</button>}
    </div></div>}
    {showReview && review && <SurfaceDialog title={review.title} size="wide" icon="diff"
      className="chat-overview-review sheet-fill sheet-edge-to-edge" onClose={() => setReview(undefined)}>
      <Suspense fallback={<p className="note" role="status">{copy('Loading changes…', '正在读取改动…')}</p>}>
        <ReviewDiffView stack projectId={review.projectId} worktreePath={review.worktreePath} sessionId={review.sessionId}
          checkpointId={review.from} toCheckpointId={review.to} editorId={`overview:${popoverId}:${review.sessionId}:${review.from}:${review.to}`}
          zh={zh} comments={comments} readFiles={review.readFiles}
          onOpenFile={surface?.openFile ? path => { surface.openFile?.({ path }); setReview(undefined); } : undefined} />
      </Suspense>
    </SurfaceDialog>}
  </>;
}

function OverviewNativeSubagent({ agent, copy, zh }: { agent: NativeSubagentSummary; copy: Copy; zh: boolean }) {
  const title = subagentTitle(agent, copy);
  const tone = agent.status === 'running' ? 'run' : agent.status === 'failed' ? 'fail' : 'done';
  return <div className={`chat-overview-row is-${tone}`} data-subagent-key={agent.key}>
    <span className={`chat-overview-tile is-${tone}`}><AgentTile provider={agent.provider} size={16} /></span>
    <span className="chat-overview-row-title" title={title}>{title}</span>
    <span className={`chat-overview-native-state is-${tone}`}>{delegationStateLabel(agent.status, zh)}</span>
  </div>;
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
      <span className={`chat-overview-tile is-${status.tone}`}><AgentTile provider={delegate.provider} size={16} /></span>
      <span className="chat-overview-row-title">{delegate.title}</span>
      <span className={`chat-overview-state is-${status.tone}${issue ? ' is-error' : ''}`} role={issue ? 'alert' : undefined} title={issue ?? status.text}>
        {issue ? copy('Stop failed', '停止失败') : status.quietSince ? <QuietMinutes since={status.quietSince} copy={copy} /> : status.text}
      </span>
      <span className="chat-overview-open-hint">{copy('Open', '打开')}</span>
    </button>
    {delegationActive(state) && <button type="button" className="chat-overview-stop" disabled={stopping} onClick={stop}>{stopping ? copy('Stopping…', '停止中…') : copy('Stop', '停止')}</button>}
  </div>;
}
