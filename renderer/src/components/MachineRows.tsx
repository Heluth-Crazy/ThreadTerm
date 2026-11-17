import { useState, type CSSProperties, type ReactNode } from 'react';
import { machineBridge, useMachines, useMachineTree } from '../machines';
import { machineTreeKey, type MachineSnapshot, type MachineTreeFeed, type MachineTreeSession, type MachineTree } from '../machineTypes';
import { Icon, SessionIcon } from './PrototypeIcon';
import { CatalogPopover } from './CatalogActions';
import { sameCanonicalScope } from '../projectScope';
import { sessionState, sessionStateLabel } from '../sessionState';
import { isTerminalAttentionSession, sessionActivity, sessionActivityLabel } from '../sessionActivity';
import { boundedExpandedParents, foldedDelegateRows } from '../delegateFold';
import { nestedDelegateIds } from '../delegation';
import {
  activeDelegateParents,
  foldExpanded,
  foldedSummaryLabel,
  foldSummary,
  orderBranchSessions,
  orderBranches,
  setCatalogFold,
  splitBranchSessions,
  uniqueWorktrees,
  worktreeLabel,
  type FoldSummary,
} from '../catalogTidy';
import { updateCatalogFolds, useCatalogFolds } from '../catalogFolds';
import './mac-sidebar.css';

export function MachineRows({ zh, children, onAddComputer }: { zh: boolean; children?: ReactNode; onAddComputer?: () => void }) {
  return <MachineRowsView zh={zh} snapshot={useMachines()} feed={useMachineTree()} onAddComputer={onAddComputer}>{children}</MachineRowsView>;
}
export function MachineRowsView({ zh, snapshot, feed = { machines: [], expanded: {} }, children, onAddComputer }: {
  zh: boolean; snapshot: MachineSnapshot; feed?: MachineTreeFeed; children?: ReactNode; onAddComputer?: () => void;
}) {
  const [issue, setIssue] = useState<string>();
  const [menu, setMenu] = useState<{ key: string; anchor: HTMLElement }>();
  const [expandedDelegates, setExpandedDelegates] = useState<string[]>([]);
  const folds = useCatalogFolds(), setFolds = updateCatalogFolds;
  if (!snapshot.enabled || snapshot.machines.length < 2) return <>{children}</>;
  const fail = (error: unknown) => setIssue(error instanceof Error ? error.message : String(error));
  const expanded = (key: string) => feed.expanded[key] !== false;
  const toggle = (key: string) => { void machineBridge()?.machineExpand(key, !expanded(key)).catch(fail); };
  const open = (id: string, sessionId?: string) => { setIssue(undefined); void machineBridge()?.machineShow(id, sessionId).catch(fail); };
  const closeMenu = () => setMenu(undefined);
  const start = (machineId: string, projectId?: string, path?: string) => { closeMenu(); setIssue(undefined); void machineBridge()?.machineShow(machineId, undefined, { action: 'new-session', projectId, path }).catch(fail); };
  const addProject = (machineId: string) => { setMenu(undefined); setIssue(undefined); void machineBridge()?.machineShow(machineId, undefined, { action: 'add-project' }).catch(fail); };
  const count = (value: number) => value > 0 && <span className="badge amber" aria-label={zh ? `${value} 项需要你` : `${value} needs you`}>{value}</span>;
  const remoteSummary = (members: MachineTreeSession[]): FoldSummary | undefined => {
    const needs = members.reduce((sum, row) => sum + row.needsYou, 0);
    if (needs) return { kind: 'needs', count: needs };
    return foldSummary(members.map(row => row.session));
  };
  const foldMark = (summary: FoldSummary | undefined) => {
    if (!summary) return null;
    const text = foldedSummaryLabel(summary, zh);
    if (summary.kind === 'needs') return <span className="badge amber" aria-label={text} title={text}>{summary.count}</span>;
    if (summary.kind === 'running') return <i className="fold-spin" role="status" aria-label={text} title={text} />;
    return <span className="badge" aria-label={text} title={text}>{summary.count}</span>;
  };
  const sessions = (tree: MachineTree, rows: MachineTreeSession[], all = rows, olderKey?: string) => {
    const byId = new Map(all.map(row => [row.session.id, row]));
    const expandedParents = all.filter(row => expandedDelegates.includes(machineTreeKey(tree.machine.id, 'delegate-fold', row.session.id))).map(row => row.session.id);
    const allSessions = all.map(row => row.session);
    const nested = nestedDelegateIds(allSessions);
    const topLevel = rows.map(row => row.session).filter(session => !nested.has(session.id));
    const ordered = orderBranchSessions(topLevel);
    const split = splitBranchSessions(ordered, { activeDelegateParents: activeDelegateParents(allSessions) });
    const olderOpen = olderKey ? foldExpanded(folds, 'older', olderKey) : false;
    const visible = olderOpen ? ordered : split.shown;
    const rendered = foldedDelegateRows(visible, allSessions, undefined, expandedParents, session => byId.get(session.id)!.needsYou > 0).map(row => {
      if (row.kind === 'fold') {
        const key = machineTreeKey(tree.machine.id, 'delegate-fold', row.parentId);
        return <div className="sess-row-wrap is-delegate" key={key} data-machine-id={tree.machine.id}><button type="button" className="sess-row delegate-fold-row" data-parent-id={row.parentId} aria-expanded={row.expanded} onClick={() => setExpandedDelegates(current => row.expanded ? current.filter(id => id !== key) : boundedExpandedParents([...current, key]))}><span className="bico" aria-hidden="true" /><span className="grow">{zh ? `${row.count} 个已结束` : `${row.count} finished`}</span></button></div>;
      }
      const session = row.session;
      const needs = byId.get(session.id)!.needsYou, activity = sessionActivity(session), terminal = isTerminalAttentionSession(session);
      const label = terminal ? sessionStateLabel(sessionState(session), zh, session.readOnly, Boolean(session.released)) : sessionActivityLabel(activity, zh);
      const dot = needs ? 'needs' : session.status === 'error' ? 'failed' : session.status === 'interrupted' ? 'stalled' : session.status === 'exited' || session.readOnly ? 'ended' : activity === 'running' || terminal && session.status === 'running' ? 'running' : 'ended';
      return <div className={`sess-row-wrap${row.nested ? ' is-delegate' : ''}`} key={machineTreeKey(tree.machine.id, 'session', session.id)} data-machine-id={tree.machine.id} data-session-id={session.id} data-activity={activity}>
        {needs > 0 && <i className="session-attention-bar" aria-hidden="true" />}
        <button type="button" className="sess-row" data-session-id={session.id} title={`${session.title} · ${label}`} onClick={() => open(tree.machine.id, session.id)}>
          <span className={`bico session-activity-${activity}`}><span className="session-agent-icon"><SessionIcon session={session} />{activity === 'running' && <i className="session-attention-ring" />}</span><i className={`bico-dot st-${dot}`} /></span>
          <span className="grow">{session.title}</span>{count(needs)}
        </button>
      </div>;
    });
    return <>{rendered}{olderKey && split.older.length > 0 && <button type="button" className="catalog-fold-row older-fold-row" aria-expanded={olderOpen} onClick={() => setFolds(current => setCatalogFold(current, 'older', olderKey, !olderOpen))}><span className="grow">{olderOpen ? (zh ? '收起较早的会话' : 'Hide older sessions') : (zh ? `更早的 ${split.older.length} 个会话` : `${split.older.length} older sessions`)}</span></button>}</>;
  };
  const remoteTree = (tree: MachineTree) => <section className="project-catalog remote-project-catalog" aria-label={zh ? '项目目录' : 'Project catalog'}>
    <div className="side-tree">{tree.projects.map(project => {
      const key = machineTreeKey(tree.machine.id, 'project', project.id), rows = tree.sessions.filter(row => row.session.projectId === project.id && !row.session.archived);
      const branches = uniqueWorktrees(tree.worktrees.filter(branch => branch.projectId === project.id));
      const localName = zh ? '本地目录' : 'Local directory';
      const membersOf = (branch: typeof branches[number]) => rows.filter(row => sameCanonicalScope(row.session.worktreePath ?? project.path, branch.path));
      const nameOf = (branch: typeof branches[number]) => worktreeLabel(branch, project.path, localName);
      const ordered = orderBranches(branches, branch => membersOf(branch).map(row => row.session), nameOf);
      // As in the own catalog: a plain directory has no branch row, and sessions outside every listed worktree sit
      // directly under the project.
      const loose = rows.filter(row => !branches.some(branch => sameCanonicalScope(branch.path, row.session.worktreePath ?? project.path)));
      return <div className="proj-group" key={key}>
        <div className="proj-row-wrap">
          <button type="button" className="proj-row" aria-expanded={expanded(key)} onClick={() => toggle(key)}><Icon name={expanded(key) ? 'folderOpen' : 'folder'} /><span className="grow">{project.name}</span>{!expanded(key) && foldMark(remoteSummary(rows))}</button>
          <button type="button" className="tree-new" aria-label={zh ? `在 ${project.name} 中新建终端` : `New terminal in ${project.name}`} onClick={() => start(tree.machine.id, project.id, project.path)}><Icon name="plus" /></button>
          <button type="button" className="icon-btn row-more" aria-label={zh ? `${project.name} 操作` : `${project.name} actions`} aria-haspopup="menu" aria-expanded={menu?.key === key} onClick={event => setMenu(menu?.key === key ? undefined : {key,anchor:event.currentTarget})}><Icon name="more" /></button>
          {menu?.key === key && <CatalogPopover anchor={menu.anchor} onClose={closeMenu} label={project.name}><button type="button" role="menuitem" className="menu-item" onClick={() => start(tree.machine.id, project.id, project.path)}><Icon name="plus" />{zh ? '新建终端' : 'New terminal'}</button></CatalogPopover>}
        </div>
        {expanded(key) && <div className="tree-list">{ordered.map(branch => {
          const branchKey = machineTreeKey(tree.machine.id, 'branch', branch.path), members = membersOf(branch), name = nameOf(branch);
          return <div className="catalog-tree-group" key={branchKey}><div className="tree-row-wrap"><button type="button" className="tree-row" aria-expanded={expanded(branchKey)} onClick={() => toggle(branchKey)}><span className="bico"><Icon name="branch" /></span><span className="branch">{name}</span>{!expanded(branchKey) && foldMark(remoteSummary(members))}</button><button type="button" className="tree-new" aria-label={zh ? `在 ${name} 中新建终端` : `New terminal in ${name}`} onClick={() => start(tree.machine.id, project.id, branch.path)}><Icon name="plus" /></button><button type="button" className="icon-btn row-more" aria-label={zh ? `${name} 操作` : `${name} actions`} aria-haspopup="menu" aria-expanded={menu?.key === branchKey} onClick={event => setMenu(menu?.key === branchKey ? undefined : {key:branchKey,anchor:event.currentTarget})}><Icon name="more" /></button>{menu?.key === branchKey && <CatalogPopover anchor={menu.anchor} onClose={closeMenu} label={name}><button type="button" role="menuitem" className="menu-item" onClick={() => start(tree.machine.id, project.id, branch.path)}><Icon name="plus" />{zh ? '新建终端' : 'New terminal'}</button></CatalogPopover>}</div>{expanded(branchKey) && sessions(tree, members, rows, `${tree.machine.id}:${branch.path}`)}</div>;
        })}{sessions(tree, loose, rows, `${tree.machine.id}:${project.id}:loose`)}</div>}
      </div>;
    })}{sessions(tree, tree.sessions.filter(row => !row.session.projectId && !row.session.archived), undefined, `${tree.machine.id}:orphans`)}</div>
  </section>;
  return <nav className="machine-rows" aria-label={zh ? '电脑' : 'Computers'}>
    {snapshot.machines.map(metadata => {
      const tree = feed.machines.find(row => row.machine.id === metadata.id), machine = tree?.machine ?? metadata;
      const online = machine.state === 'local' || machine.state === 'connected';
      const key = machineTreeKey(machine.id, 'machine', machine.id), own = snapshot.currentId === machine.id;
      const name = machine.id === 'local' && zh ? '这台电脑' : machine.name;
      return <div className="machine-group" key={key} data-machine-id={machine.id}>
        <div className="machine-row-wrap" data-state={machine.state} style={{ '--machine-color': machine.color } as CSSProperties}>
          {online && <button type="button" className={`machine-disclosure${expanded(key) ? ' open' : ''}`} aria-expanded={expanded(key)} aria-label={`${expanded(key) ? (zh ? '收起' : 'Collapse') : (zh ? '展开' : 'Expand')} ${name}`} onClick={() => toggle(key)}><Icon name="chevron" className="chev" /></button>}
          <button type="button" className={`machine-row${own ? ' active' : ''}`} aria-current={own ? 'true' : undefined} onClick={() => open(machine.id)}>
            <i className="machine-dot" aria-hidden="true" /><span className="machine-name">{name}</span>{online ? count(tree?.needsYou ?? 0) : <small>{machineStateLabel(machine.state, zh)}</small>}
          </button>
          {!own && online && <><button type="button" className="icon-btn row-more machine-more" aria-label={zh ? `${name} 操作` : `${name} actions`} aria-haspopup="menu" aria-expanded={menu?.key === key} onClick={event => setMenu(menu?.key === key ? undefined : {key,anchor:event.currentTarget})}><Icon name="more" /></button>{menu?.key === key && <CatalogPopover anchor={menu.anchor} onClose={closeMenu} label={name}><button type="button" role="menuitem" className="menu-item" onClick={() => start(machine.id)}><Icon name="plus" />{zh ? '新建终端' : 'New terminal'}</button><button type="button" role="menuitem" className="menu-item" onClick={() => addProject(machine.id)}><Icon name="folder" />{zh ? '添加项目' : 'Add project'}</button></CatalogPopover>}</>}
        </div>
        {online && expanded(key) && (own ? children : tree && remoteTree(tree))}
      </div>;
    })}
    <button type="button" className="nav-item machine-add" onClick={() => onAddComputer ? onAddComputer() : void machineBridge()?.machineSettings().catch(fail)}><Icon name="plus" />{zh ? '添加电脑' : 'Add a computer'}</button>
    {issue && <p role="alert" className="surface-error">{issue}</p>}
  </nav>;
}
export function machineStateLabel(state: MachineSnapshot['machines'][number]['state'], zh: boolean): string {
  const labels = zh ? { local: '本机', connected: '已连接', disconnected: '未连接', connecting: '连接中', incompatible: '版本不一致', 'pin-mismatch': '需重新配对' } : { local: 'Local', connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting', incompatible: 'Version mismatch', 'pin-mismatch': 'Pair again' };
  return labels[state];
}
export function MachineChrome({ zh }: { zh: boolean }) {
  const snapshot = useMachines(), machine = snapshot.machines.find(item => item.id === snapshot.currentId);
  if (snapshot.currentId === 'local' || !machine) return null;
  return <span className="machine-chip" style={{ '--machine-color': machine.color } as CSSProperties}><i className="machine-dot" aria-hidden="true" />{zh ? `在 ${machine.name}` : `on ${machine.name}`}</span>;
}
