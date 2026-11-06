import { useState, type CSSProperties, type ReactNode } from 'react';
import { machineBridge, useMachines, useMachineTree } from '../machines';
import { machineTreeKey, type MachineSnapshot, type MachineTreeFeed, type MachineTreeSession, type MachineTree } from '../machineTypes';
import { Icon, SessionIcon } from './PrototypeIcon';
import { CatalogPopover } from './CatalogActions';
import { sameCanonicalScope } from '../projectScope';
import { sessionState, sessionStateLabel } from '../sessionState';
import { isTerminalAttentionSession, sessionActivity, sessionActivityLabel, sortSessionsByActivity } from '../sessionActivity';

export function MachineRows({ zh, children, onAddComputer }: { zh: boolean; children?: ReactNode; onAddComputer?: () => void }) {
  return <MachineRowsView zh={zh} snapshot={useMachines()} feed={useMachineTree()} onAddComputer={onAddComputer}>{children}</MachineRowsView>;
}
export function MachineRowsView({ zh, snapshot, feed = { machines: [], expanded: {} }, children, onAddComputer }: {
  zh: boolean; snapshot: MachineSnapshot; feed?: MachineTreeFeed; children?: ReactNode; onAddComputer?: () => void;
}) {
  const [issue, setIssue] = useState<string>();
  const [menu, setMenu] = useState<{ key: string; anchor: HTMLElement }>();
  if (!snapshot.enabled || snapshot.machines.length < 2) return <>{children}</>;
  const fail = (error: unknown) => setIssue(error instanceof Error ? error.message : String(error));
  const expanded = (key: string) => feed.expanded[key] !== false;
  const toggle = (key: string) => { void machineBridge()?.machineExpand(key, !expanded(key)).catch(fail); };
  const open = (id: string, sessionId?: string) => { setIssue(undefined); void machineBridge()?.machineShow(id, sessionId).catch(fail); };
  const closeMenu = () => setMenu(undefined);
  const start = (machineId: string, projectId?: string, path?: string) => { closeMenu(); setIssue(undefined); void machineBridge()?.machineShow(machineId, undefined, { action: 'new-session', projectId, path }).catch(fail); };
  const addProject = (machineId: string) => { setMenu(undefined); setIssue(undefined); void machineBridge()?.machineShow(machineId, undefined, { action: 'add-project' }).catch(fail); };
  const count = (value: number) => value > 0 && <span className="badge amber" aria-label={zh ? `${value} 项需要你` : `${value} needs you`}>{value}</span>;
  const sessions = (tree: MachineTree, rows: MachineTreeSession[]) => {
    const byId = new Map(rows.map(row => [row.session.id, row]));
    return sortSessionsByActivity(rows.map(row => row.session)).map(session => {
      const needs = byId.get(session.id)!.needsYou, activity = sessionActivity(session), terminal = isTerminalAttentionSession(session);
      const label = terminal ? sessionStateLabel(sessionState(session), zh, session.readOnly) : sessionActivityLabel(activity, zh);
      const dot = needs ? 'needs' : session.status === 'error' ? 'failed' : session.status === 'interrupted' ? 'stalled' : session.status === 'exited' || session.readOnly ? 'ended' : activity === 'running' || terminal && session.status === 'running' ? 'running' : 'ended';
      return <div className="sess-row-wrap" key={machineTreeKey(tree.machine.id, 'session', session.id)} data-machine-id={tree.machine.id} data-session-id={session.id} data-activity={activity}>
        {needs > 0 && <i className="session-attention-bar" aria-hidden="true" />}
        <button type="button" className="sess-row" data-session-id={session.id} title={`${session.title} · ${label}`} onClick={() => open(tree.machine.id, session.id)}>
          <span className={`bico session-activity-${activity}`}><span className="session-agent-icon"><SessionIcon session={session} />{activity === 'running' && <i className="session-attention-ring" />}</span><i className={`bico-dot st-${dot}`} /></span>
          <span className="grow">{session.title}</span>{count(needs)}
        </button>
      </div>;
    });
  };
  const remoteTree = (tree: MachineTree) => <section className="project-catalog remote-project-catalog" aria-label={zh ? '项目目录' : 'Project catalog'}>
    <div className="side-tree">{tree.projects.map(project => {
      const key = machineTreeKey(tree.machine.id, 'project', project.id), rows = tree.sessions.filter(row => row.session.projectId === project.id && !row.session.archived);
      const branches = tree.worktrees.filter(branch => branch.projectId === project.id);
      // As in the own catalog: a plain directory has no branch row, and sessions outside every listed worktree sit
      // directly under the project.
      const loose = rows.filter(row => !branches.some(branch => sameCanonicalScope(branch.path, row.session.worktreePath ?? project.path)));
      return <div className="proj-group" key={key}>
        <div className="proj-row-wrap"><button type="button" className={`proj-disclosure${expanded(key) ? ' open' : ''}`} aria-expanded={expanded(key)} aria-label={`${expanded(key) ? (zh ? '收起' : 'Collapse') : (zh ? '展开' : 'Expand')} ${project.name}`} onClick={() => toggle(key)}><Icon name="chevron" className="chev" /></button>
          <button type="button" className="proj-row" onClick={() => toggle(key)}><Icon name="folder" /><span className="grow">{project.name}</span>{!expanded(key) && count(rows.reduce((sum, row) => sum + row.needsYou, 0))}</button>
          <button type="button" className="tree-new" aria-label={zh ? `在 ${project.name} 中新建终端` : `New terminal in ${project.name}`} onClick={() => start(tree.machine.id, project.id, project.path)}><Icon name="plus" /></button>
          <button type="button" className="icon-btn row-more" aria-label={zh ? `${project.name} 操作` : `${project.name} actions`} aria-haspopup="menu" aria-expanded={menu?.key === key} onClick={event => setMenu(menu?.key === key ? undefined : {key,anchor:event.currentTarget})}><Icon name="more" /></button>
          {menu?.key === key && <CatalogPopover anchor={menu.anchor} onClose={closeMenu} label={project.name}><button type="button" role="menuitem" className="menu-item" onClick={() => start(tree.machine.id, project.id, project.path)}><Icon name="plus" />{zh ? '新建终端' : 'New terminal'}</button></CatalogPopover>}
        </div>
        {expanded(key) && <div className="tree-list">{branches.map(branch => {
          const branchKey = machineTreeKey(tree.machine.id, 'branch', branch.path), members = rows.filter(row => sameCanonicalScope(row.session.worktreePath ?? project.path, branch.path));
          return <div className="catalog-tree-group" key={branchKey}><div className="tree-row-wrap"><button type="button" className="tree-row" aria-expanded={expanded(branchKey)} onClick={() => toggle(branchKey)}><span className="bico"><Icon name="branch" /></span><span className="branch">{branch.branch ?? (zh ? '本地目录' : 'Local directory')}</span>{count(members.reduce((sum, row) => sum + row.needsYou, 0))}</button><button type="button" className="tree-new" aria-label={zh ? `在 ${branch.branch ?? project.name} 中新建终端` : `New terminal in ${branch.branch ?? project.name}`} onClick={() => start(tree.machine.id, project.id, branch.path)}><Icon name="plus" /></button><button type="button" className="icon-btn row-more" aria-label={zh ? `${branch.branch ?? project.name} 操作` : `${branch.branch ?? project.name} actions`} aria-haspopup="menu" aria-expanded={menu?.key === branchKey} onClick={event => setMenu(menu?.key === branchKey ? undefined : {key:branchKey,anchor:event.currentTarget})}><Icon name="more" /></button>{menu?.key === branchKey && <CatalogPopover anchor={menu.anchor} onClose={closeMenu} label={branch.branch ?? project.name}><button type="button" role="menuitem" className="menu-item" onClick={() => start(tree.machine.id, project.id, branch.path)}><Icon name="plus" />{zh ? '新建终端' : 'New terminal'}</button></CatalogPopover>}</div>{expanded(branchKey) && sessions(tree, members)}</div>;
        })}{sessions(tree, loose)}</div>}
      </div>;
    })}{sessions(tree, tree.sessions.filter(row => !row.session.projectId && !row.session.archived))}</div>
  </section>;
  return <nav className="machine-rows" aria-label={zh ? '电脑' : 'Computers'}>
    {snapshot.machines.map(metadata => {
      const tree = feed.machines.find(row => row.machine.id === metadata.id), machine = tree?.machine ?? metadata;
      const online = machine.state === 'local' || machine.state === 'connected';
      const key = machineTreeKey(machine.id, 'machine', machine.id), own = snapshot.currentId === machine.id;
      const name = machine.id === 'local' && zh ? '这台电脑' : machine.name;
      return <div className="machine-group" key={key} data-machine-id={machine.id}>
        <div className="machine-row-wrap" style={{ '--machine-color': machine.color } as CSSProperties}>
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
