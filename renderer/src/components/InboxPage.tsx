import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatAnswerResponse, ChatItem, InboxItem, ProjectCatalogItem, ProviderId, Session, Snapshot, Worktree } from '@threadterm/protocol';
import { operationId, request, subscribeEvents } from '../bridge';
import { acquireControl } from '../controlLease';
import type { QuestionResponse } from '../chatQuestion';
import { delegationStateLabel } from '../delegation';
import { acceptanceEvidence, inboxWorkbench, pendingApprovalOf, type Acceptance, type DecisionItem, type InboxGoal, type OtherGroup } from '../inboxGoals';
import { inboxEventGroup, inboxKindLabel } from '../inboxVisibility';
import { isBrowserEvalApproval } from '../browserEvalApproval';
import { firstReadyAgent } from '../providerReadiness';
import { sessionTime } from '../sessionTime';
import { useTranslation } from '../i18n';
import type { SupervisionSettings as Supervision, Alert } from '../supervision';
import { AgentTile, Icon } from './PrototypeIcon';
import { ChatApprovalCard } from './ChatApprovalCard';
import { AgentPicker, type WorkbenchDefaults } from './WorkbenchPage';
import { workbenchAgents } from './workbenchAgents';
import { Select } from './ui/Select';
import { SurfaceDialog } from './SurfaceDialog';
import './inbox-page.css';

type Copy = (en: string, zh: string) => string;
type Control = { epoch: number; release(): void };
const ACTIVE = ['starting', 'running', 'awaiting_parent', 'cancelling'];

type Props = {
  data: Snapshot;
  onSession: (id: string) => void;
  onRead: () => void;
  supervision: Supervision;
  onSupervision: (value: Supervision) => Promise<void>;
  supervisionAlerts: Map<string, Alert>;
  onCreate?: (defaults?: WorkbenchDefaults) => void;
};

/** R15: 待处理 is the workbench. Decisions are answered here, finished subtasks are accepted here. */
export function InboxPage({ data, onSession, onRead, supervision, onSupervision, supervisionAlerts, onCreate }: Props) {
  const { locale, formatDate } = useTranslation();
  const zh = locale === 'zh-CN';
  const copy: Copy = (en, text) => (zh ? text : en);
  const [rules, setRules] = useState(false);
  const [draftRule, setDraftRule] = useState(supervision);
  const [detail, setDetail] = useState<InboxItem>();
  const [menu, setMenu] = useState<string>();
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [acceptAllBusy, setAcceptAllBusy] = useState<string>();
  const [sendBack, setSendBack] = useState<{ id: string; note: string }>();

  // R16: a Chat the composer just created stays on the page until the snapshot lists it.
  const [created, setCreated] = useState<Session[]>([]);
  const [goalText, setGoalText] = useState('');
  const [goalProject, setGoalProject] = useState(data.projects[0]?.id ?? '');
  const [goalProvider, setGoalProvider] = useState<ProviderId | undefined>(() => firstReadyAgent(data.providers));
  const [goalIssue, setGoalIssue] = useState<string>();
  const [goalBusy, setGoalBusy] = useState(false);
  useEffect(() => { setGoalProvider(current => current ?? firstReadyAgent(data.providers)); }, [data.providers]);

  const sessions = useMemo(() => {
    const known = new Set(data.sessions.map(session => session.id));
    const extra = created.filter(session => !known.has(session.id));
    return extra.length ? [...data.sessions, ...extra] : data.sessions;
  }, [data.sessions, created]);
  const workbench = useMemo(
    () => inboxWorkbench({ sessions, inbox: data.inbox, includeGoalIds: created.map(session => session.id) }),
    [sessions, data.inbox, created],
  );

  // R15/R17: the branch chip needs the project catalog; the snapshot has no branch.
  const [catalog, setCatalog] = useState<ProjectCatalogItem[]>([]);
  const [trees, setTrees] = useState<Record<string, Worktree[]>>({});
  useEffect(() => { void request('project.catalog.list', {}).then(setCatalog).catch(() => undefined); }, []);
  const treeRequests = useMemo(() => {
    const wanted = new Map<string, Set<string>>();
    for (const goal of workbench.goals) {
      const session = goal.parent;
      const project = data.projects.find(item => item.id === session.projectId);
      if (!session.projectId || !session.worktreePath || session.worktreePath === project?.path) continue;
      const paths = wanted.get(session.projectId);
      if (paths) paths.add(session.worktreePath); else wanted.set(session.projectId, new Set([session.worktreePath]));
    }
    return wanted;
  }, [workbench.goals, data.projects]);
  const treeKey = [...treeRequests].map(([projectId, paths]) => `${projectId}:${[...paths].sort().join(',')}`).sort().join('|');
  useEffect(() => {
    for (const [projectId, paths] of treeRequests) {
      if (trees[projectId]?.some(tree => paths.has(tree.path))) continue;
      void request('worktree.list', { projectId }).then(next => setTrees(current => ({ ...current, [projectId]: next }))).catch(() => undefined);
    }
    // Keyed by the projects and paths that need a branch, not by every array identity.
  }, [treeKey]);

  // R15: decisions need the session's chat snapshot, and acceptance needs the child's
  // (the run record lives in its delegated turn). Cached per session, refreshed on change.
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, ChatItem[]>>(new Map());
  const loading = useRef(new Set<string>());
  const neededSessions = useMemo(() => {
    const ids = new Set<string>();
    for (const goal of workbench.goals) {
      for (const row of goal.decisions) ids.add(row.item.sessionId);
      for (const row of goal.acceptances) ids.add(row.child.id);
    }
    for (const group of workbench.other) for (const row of group.decisions) ids.add(row.item.sessionId);
    return [...ids].sort();
  }, [workbench]);
  const decisionKey = neededSessions.join('\n');
  const reload = (sessionId: string) => {
    if (loading.current.has(sessionId)) return;
    loading.current.add(sessionId);
    void request('chat.snapshot', { sessionId }).then(page => {
      setSnapshots(current => new Map(current).set(sessionId, page.items));
    }).catch(() => undefined).finally(() => loading.current.delete(sessionId));
  };
  useEffect(() => {
    for (const id of neededSessions) if (!snapshots.has(id)) reload(id);
    // Keyed by id: a rerender with the same rows must not refetch every snapshot.
  }, [decisionKey]);
  useEffect(() => subscribeEvents(event => {
    if (event.event !== 'state.changed') return;
    const sessionId = (event.data as { sessionId?: unknown } | null | undefined)?.sessionId;
    if (typeof sessionId !== 'string' || !neededSessions.includes(sessionId)) return;
    reload(sessionId);
  }), [decisionKey]);

  const fail = (id: string, error: unknown) => setFailures(current => ({ ...current, [id]: messageOf(error, copy) }));
  const clearFailure = (id: string) => setFailures(current => {
    if (!(id in current)) return current;
    const next = { ...current };
    delete next[id];
    return next;
  });

  const decide = async (child: Session, decision: 'accept' | 'send_back', note?: string) => {
    const delegationId = child.delegation?.id;
    if (!delegationId) return;
    setBusy(child.id);
    clearFailure(child.id);
    try {
      await request('delegation.decide', { delegationId, decision, ...(note ? { note } : {}), operationId: operationId() });
      setSendBack(current => (current?.id === child.id ? undefined : current));
      onRead();
    } catch (error) {
      fail(child.id, error);
    } finally {
      setBusy(undefined);
    }
  };

  /** 全部接受: one decision per row, stop at the first refusal and keep its error inline. */
  const acceptAll = async (goal: InboxGoal) => {
    setAcceptAllBusy(goal.parent.id);
    for (const row of goal.acceptances) {
      clearFailure(row.child.id);
      try {
        await request('delegation.decide', { delegationId: row.delegationId, decision: 'accept', operationId: operationId() });
      } catch (error) {
        fail(row.child.id, error);
        break;
      }
    }
    setAcceptAllBusy(undefined);
    onRead();
  };

  /** R15: answer under the user's own lease, then hand control back; failures stay inline. */
  const inline = async (row: DecisionItem, run: (epoch: number) => Promise<unknown>) => {
    const id = row.item.id;
    setBusy(id);
    clearFailure(id);
    let control: Control | undefined;
    try {
      control = await acquireControl(row.session.id, () => fail(id, copy('Another window took control. Open the session to continue.', '另一个窗口取得了控制权。请打开会话继续。')));
      await run(control.epoch);
      onRead();
    } catch (error) {
      fail(id, error);
    } finally {
      control?.release();
      setBusy(undefined);
    }
  };

  const read = async (ids: string[]) => {
    if (!ids.length) return;
    try {
      await request('inbox.read', { ids, operationId: operationId() });
      setMenu(undefined);
      onRead();
    } catch (error) {
      fail(ids[0]!, error);
    }
  };
  const follow = async (session: Session, followed: boolean) => {
    try {
      await request('session.update', { sessionId: session.id, followed, operationId: operationId() });
      setMenu(undefined);
      onRead();
    } catch (error) {
      fail(session.id, error);
    }
  };
  const open = (sessionId: string) => { setMenu(undefined); onSession(sessionId); };

  /** R16: create the goal's Chat in the project root, connect it, send the text, hand the lease back. */
  const sendGoal = async () => {
    const text = goalText.trim();
    const project = data.projects.find(item => item.id === goalProject);
    const capability = data.providers.find(item => item.id === goalProvider);
    if (!text || !project || !capability) return;
    setGoalBusy(true);
    setGoalIssue(undefined);
    let control: Control | undefined;
    try {
      const session = await request('session.create', {
        cwd: project.path, projectId: project.id, provider: capability.id, mode: 'chat',
        title: text.replace(/\s+/g, ' ').slice(0, 60), operationId: operationId(),
      });
      setCreated(current => [...current, session]);
      control = await acquireControl(session.id, () => undefined);
      await request('chat.connect', { sessionId: session.id, leaseEpoch: control.epoch, operationId: operationId() });
      await request('chat.send', { sessionId: session.id, text, leaseEpoch: control.epoch, operationId: operationId() });
      setGoalText('');
      onRead();
    } catch (error) {
      setGoalIssue(messageOf(error, copy));
    } finally {
      control?.release();
      setGoalBusy(false);
    }
  };

  const agents = useMemo(() => workbenchAgents(data.providers, zh, 'preferred'), [data.providers, zh]);
  const running = sessions.filter(session => session.delegation && ACTIVE.includes(session.delegation.state)).length;
  const stalls = data.inbox.filter(item => item.kind === 'stalled' && !item.read);
  const reminders = supervision.enabled ? data.sessions.filter(session => supervisionAlerts.has(session.id)) : [];
  const unreadIn = (sessionId: string) => data.inbox.filter(item => item.sessionId === sessionId && !item.read).map(item => item.id);
  const branchOf = (session: Session) => branchLabel(session, data.projects, catalog, trees);

  const decisionCard = (row: DecisionItem, parent?: Session) => {
    const key = row.item.id;
    const found = pendingApprovalOf(snapshots.get(row.session.id) ?? [], key);
    const failure = failures[key];
    if (!found || isBrowserEvalApproval(found.part)) {
      // A browser-eval approval needs a live page; anything unresolved needs the session.
      return <NoticeRow key={key} item={row.item} session={row.session} copy={copy} zh={zh} locale={locale} menu={menu} setMenu={setMenu} onOpen={() => open(row.session.id)} onRead={ids => void read(ids)} onFollow={follow} onDetail={setDetail} allUnread={unreadIn(row.session.id)} />;
    }
    const { item, part } = found;
    return <div className="it decide" key={key} data-inbox-item={key}>
      <div className="it-head">
        <span className="kindtag decide"><Icon name="bell" />{copy('Decision needed', '要你决定')}</span>
        {parent && parent.id !== row.session.id && <span className="it-from">{copy('From', '来自')} {row.session.title}</span>}
        <span className="tm">{sessionTime(row.item.createdAt, locale)}</span>
      </div>
      <div className={`chat-part approval v3-tool-card ${part.status ?? ''}`}>
        <ChatApprovalCard
          part={part}
          writable={!busy}
          submitting={busy === key ? 'pending' : undefined}
          onChoose={choiceId => void inline(row, epoch => request('chat.approve', { sessionId: row.session.id, turnId: item.turnId ?? '', approvalId: part.approvalId ?? '', choiceId, leaseEpoch: epoch, operationId: operationId() }))}
          onAnswer={(response: QuestionResponse) => void inline(row, epoch => request('chat.answer', { sessionId: row.session.id, turnId: item.turnId ?? '', approvalId: part.approvalId ?? '', response, leaseEpoch: epoch, operationId: operationId() }))}
          onPlanResponse={(response: ChatAnswerResponse) => void inline(row, epoch => request('chat.answer', { sessionId: row.session.id, turnId: item.turnId ?? '', approvalId: part.approvalId ?? '', response, leaseEpoch: epoch, operationId: operationId() }))}
          copy={copy}
          zh={zh}
        />
      </div>
      {failure && <FailureRow id={key} message={failure} copy={copy} onOpen={() => open(row.session.id)} />}
    </div>;
  };

  const noticeRow = (item: InboxItem, session: Session) => <NoticeRow key={item.id} item={item} session={session} copy={copy} zh={zh} locale={locale} menu={menu} setMenu={setMenu} onOpen={() => open(session.id)} onRead={ids => void read(ids)} onFollow={follow} onDetail={setDetail} allUnread={unreadIn(session.id)} />;

  const otherGroup = (group: OtherGroup) => <div className="other-session" key={group.session.id}>
    <div className="other-head">
      <AgentTile provider={group.session.provider} size={16} />
      <span className="title">{group.session.title}</span>
      <button type="button" className="open" onClick={() => open(group.session.id)}>{copy('Open', '打开')}<Icon name="chevR" /></button>
    </div>
    {group.decisions.map(row => decisionCard(row))}
    {group.notices.map(row => noticeRow(row.item, row.session))}
  </div>;

  return <section className="page inbox-page">
    <div className="inbox-wrap">
      <div className="page-head">
        <div>
          <h1 className="page-title">{copy('Inbox', '待处理')}{workbench.pending > 0 && <span className="count">{workbench.pending}</span>}</h1>
          <p className="page-sub">{copy('Only two things land here: decisions and acceptance. The main agent handles the rest.', '只放两类事：要你决定的，要你验收的。其余的主 Agent 自己处理。')}</p>
        </div>
        <div className="page-actions"><button type="button" className="btn" onClick={() => { setDraftRule(supervision); setRules(true); }}>{copy('Rules', '规则')}</button></div>
      </div>

      {onCreate && data.projects.length > 0 && <div className="newgoal">
        <textarea
          className="newgoal-input"
          rows={2}
          maxLength={2000}
          value={goalText}
          aria-label={copy('New goal', '新目标')}
          placeholder={copy('Describe a goal for a main agent…', '交代一个新目标…')}
          onChange={event => setGoalText(event.target.value)}
        />
        <div className="newgoal-row workbench-page">
          <AgentPicker value={goalProvider} onChange={setGoalProvider} agents={agents} data={data} projectId={goalProject} zh={zh} label={copy('Choose agent', '选择 Agent')} onCreated={session => onSession(session.id)} />
          <label className="composer-chip">
            <Icon name="folder" />
            <Select className="composer-select" value={goalProject} onChange={event => setGoalProject(event.target.value)} aria-label={copy('Choose project', '选择项目')}>
              {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </Select>
          </label>
          <button type="button" className="composer-send" aria-label={copy('Send goal', '交代目标')} disabled={goalBusy || !goalText.trim() || !goalProvider} onClick={() => void sendGoal()}><Icon name="arrowUp" /></button>
        </div>
        {goalIssue && <p className="surface-error" role="alert">{goalIssue}</p>}
      </div>}

      {workbench.pending === 0 && <div className="calm">
        <span className="ok"><Icon name="check" /></span>
        <div>
          <b>{copy('Nothing needs you right now', '没有要你处理的事')}</b>
          {running > 0
            ? copy(`Main agents are working on ${running} ${running === 1 ? 'subtask' : 'subtasks'}. Decisions and finished work appear here.`, `主 Agent 正在推进 ${running} 个子任务。要你决定或验收的事会出现在这里。`)
            : copy('Decisions and finished subtasks appear here as your goals progress.', '目标推进时，要你决定或验收的事会出现在这里。')}
        </div>
      </div>}

      {workbench.goals.map(goal => <GoalSection
        key={goal.parent.id}
        goal={goal}
        branch={branchOf(goal.parent)}
        snapshots={snapshots}
        failures={failures}
        busy={busy}
        acceptAllBusy={acceptAllBusy}
        sendBack={sendBack}
        setSendBack={setSendBack}
        copy={copy} zh={zh} locale={locale}
        menu={menu} setMenu={setMenu}
        inbox={data.inbox}
        onOpen={open}
        onDecide={decide}
        onAcceptAll={acceptAll}
        onRead={ids => void read(ids)}
        onFollow={follow}
        onDetail={setDetail}
        decisionCard={row => decisionCard(row, goal.parent)}
        noticeRow={noticeRow}
      />)}

      {workbench.other.length > 0 && <section className="goal other-goal" aria-label={copy('Other sessions', '其他会话')}>
        <div className="goal-head">
          <span className="gt"><Icon name="inbox" /></span>
          <span className="title">{copy('Other sessions', '其他会话')}</span>
        </div>
        <div className="items">{workbench.other.map(otherGroup)}</div>
      </section>}

      {stalls.map(item => {
        const session = data.sessions.find(value => value.id === item.sessionId);
        return <div className="stalled-note" key={item.id}>
          <span className="dot st-stalled" />
          <span className="grow">{copy('Stalled reminder: ', '停摆提醒：')}{item.title}{copy('. A reminder does not indicate failure.', '。提醒不表示失败或需要处理。')}</span>
          <button type="button" className="btn btn-sm" disabled={!session || session.followed} onClick={() => session && void follow(session, true)}>{session?.followed ? copy('Following', '已关注') : copy('Follow', '关注')}</button>
        </div>;
      })}
      {reminders.map(session => <div className="stalled-note" key={session.id}>
        <span className="dot st-stalled" />
        <span className="grow">{session.title} · {copy('No output changes for', '连续没有输出')} {Math.floor((Date.now() - (supervisionAlerts.get(session.id)?.idleSince ?? Date.now())) / 60000)} {copy('minutes', '分钟')}</span>
        <button type="button" className="btn btn-sm" onClick={() => open(session.id)}>{copy('View', '查看')}</button>
      </div>)}

      {rules && <SurfaceDialog title={copy('Reminder rules', '提醒规则')} icon="bell" size="sm" onClose={() => setRules(false)} footer={<>
        <button type="button" className="btn" onClick={() => setRules(false)}>{copy('Cancel', '取消')}</button>
        <button type="button" className="btn btn-primary" onClick={() => void onSupervision(draftRule).then(() => setRules(false)).catch(error => fail('rules', error))}>{copy('Save', '保存')}</button>
      </>}>
        <div className="inbox-rules">
          <label><input type="checkbox" checked={draftRule.enabled} onChange={event => setDraftRule(value => ({ ...value, enabled: event.target.checked }))} />{copy('Enable inactivity supervision', '开启停摆监督')}</label>
          <label>{copy('Observation range (minutes)', '观察范围（分钟）')}<input type="number" min="5" max="60" step="5" value={draftRule.rangeMinutes} onChange={event => setDraftRule(value => ({ ...value, rangeMinutes: Math.max(5, Math.min(60, Number(event.target.value) || 5)) }))} /></label>
          <label>{copy('Consecutive stall threshold', '连续停摆阈值')}<input type="number" min="1" max="8" value={draftRule.threshold} onChange={event => setDraftRule(value => ({ ...value, threshold: Math.max(1, Math.min(8, Number(event.target.value) || 1)) }))} /></label>
          <p>{copy('This window checks actual output every minute. Reminders do not stop sessions, send replies or grant approval.', '从当前窗口开始观察，每分钟检查实际输出。提醒不会停止会话，也不发送回复或授予审批。')}</p>
          {failures.rules && <p className="surface-error" role="alert">{failures.rules}</p>}
        </div>
      </SurfaceDialog>}

      {detail && <SurfaceDialog title={detail.title} icon="inbox" size="sm" onClose={() => setDetail(undefined)}>
        <div className="inbox-record">
          <p>{inboxKindLabel(detail.kind, zh)} · {formatDate(detail.createdAt)}</p>
          <p>{data.sessions.find(session => session.id === detail.sessionId)?.title ?? detail.sessionId}</p>
          <button type="button" className="btn btn-primary" onClick={() => { const target = detail.sessionId; setDetail(undefined); open(target); }}>{copy('Open session', '打开会话')}</button>
        </div>
      </SurfaceDialog>}
    </div>
  </section>;
}

/** R15: the goal's branch from the project catalog, or the folder name while it loads. */
export function branchLabel(session: Session, projects: Snapshot['projects'], catalog: readonly ProjectCatalogItem[], trees: Readonly<Record<string, readonly Worktree[]>>): string {
  const project = projects.find(item => item.id === session.projectId);
  const folder = session.worktreePath?.split(/[\\/]/).filter(Boolean).at(-1);
  if (!project) return folder ?? session.title;
  if (!session.worktreePath || session.worktreePath === project.path) return catalog.find(item => item.id === project.id)?.git.branch ?? folder ?? project.name;
  const branch = trees[project.id]?.find(tree => tree.path === session.worktreePath)?.branch;
  return branch ?? folder ?? project.name;
}

function GoalSection({ goal, branch, snapshots, failures, busy, acceptAllBusy, sendBack, setSendBack, copy, zh, locale, menu, setMenu, inbox, onOpen, onDecide, onAcceptAll, onRead, onFollow, onDetail, decisionCard, noticeRow }: {
  goal: InboxGoal;
  branch: string;
  snapshots: ReadonlyMap<string, ChatItem[]>;
  failures: Record<string, string>;
  busy?: string;
  acceptAllBusy?: string;
  sendBack?: { id: string; note: string };
  setSendBack: (value?: { id: string; note: string }) => void;
  copy: Copy; zh: boolean; locale: string; menu?: string; setMenu: (value?: string) => void;
  inbox: readonly InboxItem[];
  onOpen: (sessionId: string) => void;
  onDecide: (child: Session, decision: 'accept' | 'send_back', note?: string) => Promise<void>;
  onAcceptAll: (goal: InboxGoal) => Promise<void>;
  onRead: (ids: string[]) => void;
  onFollow: (session: Session, followed: boolean) => Promise<void>;
  onDetail: (item: InboxItem) => void;
  decisionCard: (row: DecisionItem) => ReactNode;
  noticeRow: (item: InboxItem, session: Session) => ReactNode;
}) {
  const running = goal.children.filter(child => child.delegation && ACTIVE.includes(child.delegation.state)).length;
  const activity = goal.activity?.child;
  const empty = goal.decisions.length === 0 && goal.acceptances.length === 0 && goal.notices.length === 0;
  return <section className="goal" data-goal-id={goal.parent.id}>
    <div className="goal-head">
      <span className={`gt${goal.parent.status === 'running' ? ' ring' : ''}`}><AgentTile provider={goal.parent.provider} size={22} /></span>
      <span className="title">{goal.parent.title}</span>
      <span className="chip-br"><Icon name="branch" />{branch}</span>
      <span className="prog">
        {goal.children.length > 0 && <span className="kidstack">{goal.children.slice(0, 6).map(child => <span key={child.id} className={`k${child.delegation && ACTIVE.includes(child.delegation.state) ? '' : ' off'}`}><AgentTile provider={child.provider} size={14} /></span>)}</span>}
        {running > 0
          ? copy(`${running} ${running === 1 ? 'subtask' : 'subtasks'} running`, `${running} 个子任务在跑`)
          : goal.children.length > 0 ? copy('Subtasks finished', '子任务都结束了') : copy('Just started', '刚开始')}
      </span>
      <button type="button" className="open" onClick={() => onOpen(goal.parent.id)}>{copy('Open', '打开')}<Icon name="chevR" /></button>
    </div>
    {activity && <div className="goal-act">
      <span className="tm">{sessionTime(activity.updatedAt, locale)}</span>
      <span className="tx">{activity.title} {activity.delegation ? delegationStateLabel(activity.delegation.state, zh) : ''}</span>
    </div>}
    {!empty && <div className="items">
      {goal.decisions.map(decisionCard)}
      {goal.acceptances.length > 1 && <div className="items-bar">
        <span className="grow">{copy(`${goal.acceptances.length} waiting for acceptance`, `${goal.acceptances.length} 项待验收`)}</span>
        <button type="button" className="btn btn-sm btn-primary" disabled={Boolean(acceptAllBusy)} onClick={() => void onAcceptAll(goal)}>{copy(`Accept all (${goal.acceptances.length})`, `全部接受（${goal.acceptances.length}）`)}</button>
      </div>}
      {goal.acceptances.map(row => <AcceptanceRow
        key={row.child.id}
        row={row}
        items={snapshots.get(row.child.id) ?? []}
        busy={busy === row.child.id || acceptAllBusy === goal.parent.id}
        failure={failures[row.child.id]}
        sendBack={sendBack?.id === row.child.id ? sendBack : undefined}
        setSendBack={setSendBack}
        copy={copy} zh={zh}
        onAccept={() => void onDecide(row.child, 'accept')}
        onSendBack={note => void onDecide(row.child, 'send_back', note)}
        onOpen={() => onOpen(row.child.id)}
      />)}
      {goal.notices.map(row => noticeRow(row.item, row.session))}
    </div>}
    {goal.processed > 0 && <div className="donebar"><Icon name="check" />{copy(`Handled ${goal.processed}`, `已处理 ${goal.processed} 项`)}</div>}
  </section>;
}

function AcceptanceRow({ row, items, busy, failure, sendBack, setSendBack, copy, zh, onAccept, onSendBack, onOpen }: {
  row: Acceptance; items: readonly ChatItem[]; busy: boolean; failure?: string;
  sendBack?: { id: string; note: string }; setSendBack: (value?: { id: string; note: string }) => void;
  copy: Copy; zh: boolean; onAccept: () => void; onSendBack: (note: string) => void; onOpen: () => void;
}) {
  const evidence = acceptanceEvidence(items);
  const warn = evidence.some(item => item.failed);
  return <div className="it accept" data-accept-id={row.child.id}>
    <div className="acc-grid">
      <AgentTile provider={row.child.provider} size={18} />
      <div className="acc-main">
        <div className="acc-title">{row.child.title}<span className="stat">{delegationStateLabel('completed', zh)}</span></div>
        <div className="acc-ev">
          {evidence.length > 0 ? <>
            <span className={`proof${warn ? ' warn' : ''}`}><Icon name="check" />{copy('Run record', '运行记录')}</span>
            {evidence.map((item, index) => <span className="acc-cmd" key={index}><code>{item.command}</code><span className="acc-exit">→ {item.exitCode !== undefined ? item.exitCode : item.status}</span></span>)}
          </> : <span className="acc-empty">{copy('No command was run', '没有运行命令')}</span>}
        </div>
        {row.child.delegation?.outcome && <div className="acc-note">{row.child.delegation.outcome}</div>}
        {sendBack && <form className="acc-back" onSubmit={event => { event.preventDefault(); if (sendBack.note.trim()) onSendBack(sendBack.note.trim()); }}>
          <input
            aria-label={copy('Why send it back', '打回原因')}
            autoFocus
            maxLength={2000}
            value={sendBack.note}
            placeholder={copy('What should the agent fix?', '要主 Agent 改什么？')}
            onChange={event => setSendBack({ id: sendBack.id, note: event.target.value })}
          />
          <button type="submit" className="btn btn-sm" disabled={busy || !sendBack.note.trim()}>{copy('Send back', '打回')}</button>
          <button type="button" className="btn btn-sm" onClick={() => setSendBack(undefined)}>{copy('Cancel', '取消')}</button>
        </form>}
        {failure && <FailureRow id={row.child.id} message={failure} copy={copy} onOpen={onOpen} />}
      </div>
      <div className="acc-btns">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setSendBack({ id: row.child.id, note: '' })}>{copy('Send back', '打回')}</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={onAccept}>{copy('Accept', '接受')}</button>
      </div>
    </div>
  </div>;
}

function NoticeRow({ item, session, copy, zh, locale, menu, setMenu, onOpen, onRead, onFollow, onDetail, allUnread }: {
  item: InboxItem; session: Session; copy: Copy; zh: boolean; locale: string; menu?: string; setMenu: (value?: string) => void;
  onOpen: () => void; onRead: (ids: string[]) => void; onFollow: (session: Session, followed: boolean) => Promise<void>; onDetail: (item: InboxItem) => void; allUnread: string[];
}) {
  const group = inboxEventGroup(item.kind);
  const state = group === 'failed' ? 'failed' : item.kind === 'autowake_exhausted' || group === 'review' ? 'ended' : item.kind === 'stalled' ? 'stalled' : 'needs';
  return <div className="it notice" data-inbox-item={item.id}>
    <span className={`dot st-${state}`} />
    <span className={`chip st-${state}`}>{inboxKindLabel(item.kind, zh)}</span>
    <span className="notice-title">{item.title}</span>
    <span className="tm">{sessionTime(item.createdAt, locale)}</span>
    <button type="button" className="btn btn-sm" onClick={onOpen}>{copy('View', '查看')}</button>
    <div className="inbox-menu-anchor">
      <button type="button" className="icon-btn icon-btn-sm" aria-expanded={menu === item.id} aria-label={`${item.title} ${copy('more actions', '更多操作')}`} onClick={() => setMenu(menu === item.id ? undefined : item.id)}><Icon name="more" /></button>
      {menu === item.id && <div className="menu inbox-menu" role="menu">
        <button type="button" role="menuitem" className="menu-item" onClick={() => onRead([item.id])}>{copy('Mark read', '标为已读')}</button>
        <button type="button" role="menuitem" className="menu-item" onClick={() => onRead(allUnread)}>{copy('Mark this session read', '此会话全部标为已读')}</button>
        <button type="button" role="menuitem" className="menu-item" onClick={() => void onFollow(session, !session.followed)}>{session.followed ? copy('Unfollow', '取消关注') : copy('Follow session', '关注会话')}</button>
        <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(undefined); onDetail(item); }}>{copy('Record details', '查看记录详情')}</button>
      </div>}
    </div>
  </div>;
}

function FailureRow({ id, message, copy, onOpen }: { id: string; message: string; copy: Copy; onOpen: () => void }) {
  return <p className="inbox-item-error" role="alert" data-failure={id}>{message}
    <button type="button" className="btn btn-sm" onClick={onOpen}>{copy('Open session', '打开会话')}</button>
  </p>;
}

function messageOf(error: unknown, copy: Copy): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error:\s*)?/i, '').trim() || copy('The action did not go through.', '操作未完成。');
}
