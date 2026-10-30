import { useEffect, useId, useMemo, useRef, useState } from 'react';
 import type { DetectedRunEntry, QuickLaunchCommand, QuickLaunchRepoEntry, Session } from '@threadterm/protocol';
 import { operationId, request, subscribeEvents } from '../bridge';
import { useTranslation } from '../i18n';
import { detectedSections, detectedSourceLabel, previewReady, quickLaunchError, runStateLabel } from '../quickLaunch';
import { useVisibleTicker } from '../visibleTicker';
import { isKeyboardEditableTarget } from '../workbench/scmKeyboard';
import type { WorkbenchActions, WorkbenchScope } from '../workbench/types';
import {
 currentRunEntry, filterRunEntries, formatUptime, runCurrentConfigs, runningRows, RUN_FILTER_FROM, RUN_SHORTCUTS,
 runShortcutLabel, uptimeMs, type RunCommandRequest,
} from '../workbench/runView';
import { CommandEditor, ImportScripts } from './QuickLaunch';
import { RunSetupSection } from './RunSetupSection';
import { activeSequenceForCommand, allocatedRunPort, sequenceChipText } from '../runSequence';
import { Icon } from './PrototypeIcon';
import { showContextMenu } from './ContextMenu';
 import { detectedRunEntries, AgentTag, Play, repoRunEntries, RunEntryPrimary, RunEntryRow, RunUrlLink, runCatalogReady, runEntrySessions, savedRunEntries, useRunCatalog, type RunEntry } from './RunRows';
 import { RunRepoDetails } from './RunRepoDetails';
 import { agentStartLabel } from '../workbench/runView';
import './quick-launch.css';
import './run-view.css';

/** The Run side bar view: running processes across the project's worktrees, the Saved and Detected entries of this
 * worktree, and the current configuration with Restart, Stop and the F5 keys. */
export function RunViewPanel({scope, sessions, actions, zh, visible, command, onCommandHandled}:{
 scope:WorkbenchScope;
 /** Every session of the runtime snapshot; the view filters to this project so other worktrees' runs are listed. */
 sessions:Session[];
 actions:WorkbenchActions;
 zh:boolean;
 visible:boolean;
 command?:RunCommandRequest;
 onCommandHandled?:(key:string) => void;
}) {
 const { locale } = useTranslation(), chinese = zh || locale === 'zh-CN';
 const copy = (en:string, cn:string) => chinese ? cn : en;
 const root = scope.rootPath, runScope = { projectId:scope.projectId, root };
 const projectSessions = useMemo(() => sessions.filter(session => session.projectId === scope.projectId), [sessions, scope.projectId]);
 const sessionIds = useMemo(() => new Set(projectSessions.map(session => session.id)), [projectSessions]);
 const catalog = useRunCatalog({ projectId:scope.projectId, root, live:visible, zh:chinese, sessionIds });
 const [busy, setBusy] = useState(false);
 const [issue, setIssue] = useState<string>();
 const [filter, setFilter] = useState('');
 const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
 const [now, setNow] = useState(() => Date.now());
 const [help, setHelp] = useState(false);
 const [, setConfigRevision] = useState(0);
 const [editor, setEditor] = useState<QuickLaunchCommand|'new'|DetectedRunEntry|QuickLaunchRepoEntry>();
 const [importing, setImporting] = useState(false);
 const [sequenceRuns, setSequenceRuns] = useState<import('@threadterm/protocol').WorktreeSetupRun[]>([]);
 const handled = useRef<string|undefined>(undefined);
 const id = useId(), helpId = `${id}-help`;
 // Uptime is the only timer: one tick per second, only while this view is visible.
 useVisibleTicker(() => setNow(Date.now()), visible);
 const running = useMemo(() => runningRows(projectSessions, runScope), [projectSessions, scope.projectId, root]);
 const saved = savedRunEntries(catalog.commands);
 const detected = detectedRunEntries(catalog.detected);
 const repo = repoRunEntries(catalog.repo.entries);
 const everything = [...saved, ...repo, ...detected];
 const current = currentRunEntry(runScope, projectSessions, runCurrentConfigs.get(runScope));
 const currentEntry = current ? everything.find(entry => entry.commandId === current.commandId) : undefined;
 const currentRun = current ? running.find(row => row.current && row.commandId === current.commandId)?.session : undefined;
 useEffect(() => { if (!visible) return; let active=true; const refresh=()=>{void request('quickLaunch.setup.status',{projectId:scope.projectId}).then(value=>{if(active)setSequenceRuns(value);}).catch(()=>{});}; refresh(); const unsubscribe=subscribeEvents(event=>{const data=event.data as {kind?:unknown;projectId?:unknown}|undefined;if(event.event==='state.changed'&&data?.kind==='quickLaunch.setup'&&data.projectId===scope.projectId)refresh();}); return()=>{active=false;unsubscribe();}; }, [visible,scope.projectId]);

 const perform = async (task:() => Promise<void>) => {
  if (busy) return;
  setBusy(true); setIssue(undefined);
  try { await task(); }
  catch (error) { setIssue(quickLaunchError(error, chinese)); }
  finally { setBusy(false); }
 };
 const open = (sessionId:string) => actions.openSession?.(sessionId);
 const runEntry = (entry:RunEntry) => perform(async () => {
  const result = entry.source === 'detected'
   ? await request('quickLaunch.run', { detectedKey:entry.key, projectId:scope.projectId, cwd:root, operationId:operationId() })
   : entry.source === 'repo'
    ? await request('quickLaunch.run', { repoId:entry.key, projectId:scope.projectId, cwd:root, operationId:operationId() })
    : await request('quickLaunch.run', { commandId:entry.key, cwd:root, operationId:operationId() });
  open(result.session.id);
 });
 const stopRun = (session:Session) => perform(async () => { await request('session.stop', { sessionId:session.id, operationId:operationId() }); });
 const restartRun = (session:Session) => perform(async () => {
  const result = await request('quickLaunch.restart', { sessionId:session.id, operationId:operationId() });
  open(result.session.id);
 });
 const stopAll = () => perform(async () => {
  for (const row of runningRows(projectSessions, runScope).filter(candidate => candidate.current)) await request('session.stop', { sessionId:row.session.id, operationId:operationId() });
 });
 const runCurrent = () => { if (currentEntry) void runEntry(currentEntry); };
 const stopCurrent = () => { if (currentRun) void stopRun(currentRun); };
 // Restart of a configuration that is not running starts it, which is what Restart means in a Run view.
 const restartCurrent = () => { if (currentRun) void restartRun(currentRun); else if (currentEntry) void runEntry(currentEntry); };
 const setCurrent = (entry:RunEntry) => {
  runCurrentConfigs.choose(runScope, { commandId:entry.commandId, name:entry.name, source:entry.source });
  setConfigRevision(value => value + 1);
 };
 // The palette's Run entries and "Stop all in this worktree" arrive through the workbench command channel, so a
 // palette that is not bound to this workspace can never reach it. The command waits for the first catalog read, so a
 // palette that opens the view for the first time still finds its entry.
 useEffect(() => {
  if (!command || command.key === handled.current || !runCatalogReady(catalog)) return;
  handled.current = command.key;
  onCommandHandled?.(command.key);
  if (command.stopAll) { void stopAll(); return; }
  // Ctrl+F5 / Shift+F5 / Ctrl+Shift+F5 arrive from the workspace's key handler, which also shows this view.
  if (command.current === 'run') { runCurrent(); return; }
  if (command.current === 'stop') { stopCurrent(); return; }
  if (command.current === 'restart') { restartCurrent(); return; }
  const entry = everything.find(candidate => command.commandId ? candidate.commandId === command.commandId : candidate.key === command.detectedKey);
  if (entry) void runEntry(entry);
 }, [command?.key, catalog.loading, catalog.detecting, catalog.repoLoading, catalog.commands, catalog.repo, catalog.detected]);

 const rowMenu = (entry:RunEntry, session:Session|undefined, event:React.MouseEvent<HTMLElement>) => {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const isCurrent = current?.commandId === entry.commandId;
  showContextMenu({
   x:box.left, y:box.bottom, restoreFocus:event.currentTarget as HTMLElement,
   items:[
    { id:'run', label:session ? copy('Open terminal', '打开终端') : copy('Run','运行'), disabled:busy || Boolean(entry.missingTool), reason:entry.missingTool, onSelect:() => session ? open(session.id) : runEntry(entry) },
    { id:'current', label:copy('Set as current','设为当前'), shortcut:isCurrent ? copy('Current','当前') : undefined, disabled:isCurrent, onSelect:() => setCurrent(entry) },
    ...(session ? [
     { id:'restart', label:copy('Restart','重启'), disabled:busy, onSelect:() => restartRun(session) },
     { id:'stop', label:copy('Stop','停止'), disabled:busy, onSelect:() => stopRun(session) },
    ] : []),
    { id:'separator', label:'', separator:true },
    entry.source === 'detected'
     ? { id:'save', label:copy('Save as command…','另存为命令…'), disabled:busy, onSelect:() => setEditor(entry.detected!) }
     : entry.source === 'repo'
      ? { id:'edit', label:copy('Edit command…','编辑命令…'), disabled:busy, onSelect:() => setEditor(entry.repo!) }
      : { id:'edit', label:copy('Edit command…','编辑命令…'), disabled:busy, onSelect:() => setEditor(entry.saved!) },
   ],
  });
 };

 const toggleGroup = (key:string) => setCollapsed(value => { const next = new Set(value); if (next.has(key)) next.delete(key); else next.add(key); return next; });
 // Roving keyboard over the rows, as in Source Control: arrows, Home and End move focus; Enter activates the focused
 // button natively and Delete does nothing, because a run row owns no destructive default.
 const roveRows = (event:React.KeyboardEvent<HTMLDivElement>) => {
  if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key) || isKeyboardEditableTarget(event.target)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-run-primary]')).filter(button => !button.disabled);
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
 };
 const base:{key:string;label:string;rows:RunEntry[];sub?:{name:string;rows:RunEntry[]}[]}[] = [
  { key:'saved', label:copy('Saved','已保存'), rows:saved },
  ...(catalog.repo.exists ? [{ key:'repo', label:copy('Shared (repo)','共享（仓库）'), rows:repo }] : []),
  ...detectedSections(catalog.detected).map(section => ({
   key:`detected:${section.kind}`,
   label:detectedSourceLabel(section.kind, chinese),
   rows:detectedRunEntries(section.groups.flatMap(group => group.entries)),
   sub:section.groups.map(group => ({ name:group.name, rows:detectedRunEntries(group.entries) })),
  })),
 ];
 const groups = base.map(group => {
  if (!filter.trim()) return group;
  return {
   ...group,
   rows:filterRunEntries(group.rows, filter),
   sub:group.sub?.map(section => ({ ...section, rows:filterRunEntries(section.rows, filter) })).filter(section => section.rows.length),
  };
 }).filter(group => group.rows.length || (group.key === 'repo' && catalog.repo.exists && !filter.trim()));
 const shown = groups.reduce((total, group) => total + group.rows.length, 0);

 const renderRow = (entry:RunEntry) => {
  const { active } = runEntrySessions(projectSessions, entry.commandId, root);
  const sequence = activeSequenceForCommand(sequenceRuns, root, entry.commandId), sequenceText=sequenceChipText(sequence,chinese);
  return <RunEntryRow key={entry.commandId} entry={entry} session={active} zh={chinese} busy={busy}
   current={current?.commandId === entry.commandId}
    agentLabel={agentStartLabel(active?.run?.startedBy, sessions, chinese)}
    details={entry.repo ? <RunRepoDetails entry={entry.repo} zh={chinese} busy={busy} onEdit={() => setEditor(entry.repo!)} onTrust={() => void perform(async () => { await request('quickLaunch.repo.trust',{projectId:scope.projectId,cwd:root,id:entry.repo!.id,fingerprint:entry.repo!.fingerprint,operationId:operationId()}); catalog.refresh(); })}/> : undefined}
   actions={<>
    <RunEntryPrimary entry={entry} active={active} busy={busy} zh={chinese} onRun={() => void runEntry(entry)} onOpen={open}/>
    <button type="button" className="icon-btn" data-testid={`run-row-menu-${entry.key}`} aria-label={`${copy('More actions','更多操作')} ${entry.name}`} aria-haspopup="menu" title={copy('More actions','更多操作')} onClick={event => rowMenu(entry, active, event)}><Icon name="more"/></button>
   </>} sequenceText={sequenceText} onCancelSequence={sequence?.state==='running'?()=>void perform(async()=>{await request('quickLaunch.sequence.cancel',{id:sequence.id,operationId:operationId()});}):undefined}/>;
 };

 return <div className="wb-run" data-testid="run-view" data-run-scope={`${scope.projectId}\0${root}`} onKeyDown={roveRows}>
  <div className="wb-run-head" data-testid="run-current-head">
   <div className="wb-run-current">
    <span className="wb-run-label">{copy('Current configuration','当前配置')}</span>
    <strong data-testid="run-current" title={current?.name}>{current?.name ?? copy('None yet','暂无')}</strong>
    <button type="button" className="icon-btn wb-run-help-btn" aria-label={copy('About the current configuration','关于当前配置')} aria-expanded={help} aria-controls={helpId} title={copy('About the current configuration','关于当前配置')} onClick={() => setHelp(value => !value)}><span aria-hidden="true">?</span></button>
   </div>
   <div className="wb-run-keys">
    <button type="button" className="btn btn-sm" data-testid="run-current-run" disabled={busy || !currentEntry} aria-keyshortcuts={RUN_SHORTCUTS.run} title={`${copy('Run','运行')} (${runShortcutLabel('run')})`} onClick={runCurrent}><Play/>{copy('Run','运行')}</button>
    <button type="button" className="btn btn-sm" data-testid="run-current-stop" disabled={busy || !currentRun} aria-keyshortcuts={RUN_SHORTCUTS.stop} title={`${copy('Stop','停止')} (${runShortcutLabel('stop')})`} onClick={stopCurrent}>{copy('Stop','停止')}</button>
    <button type="button" className="btn btn-sm" data-testid="run-current-restart" disabled={busy || !currentEntry} aria-keyshortcuts={RUN_SHORTCUTS.restart} title={`${copy('Restart','重启')} (${runShortcutLabel('restart')})`} onClick={restartCurrent}>{copy('Restart','重启')}</button>
   </div>
   {help && <p className="wb-run-help" id={helpId} role="note">{copy('The last entry run from this worktree, or the one you set as current from a row menu. While the workbench has focus: Ctrl+F5 runs it, Shift+F5 stops it, Ctrl+Shift+F5 restarts it.','当前配置是此工作树最后运行的条目，也可以在行菜单中设为当前。工作台聚焦时：Ctrl+F5 运行，Shift+F5 停止，Ctrl+Shift+F5 重启。')}</p>}
  </div>
  {(issue ?? catalog.issue) && <p className="wb-issue" role="alert">{issue ?? catalog.issue}</p>}

  <section className="wb-run-section" data-testid="run-running" aria-label={copy('Running','运行中')}>
   <header className="wb-run-section-head"><span className="wb-section-label">{copy('Running','运行中')}</span><span className="wb-count">{running.length}</span>
    <button type="button" className="btn btn-sm btn-ghost" data-testid="run-stop-all" disabled={busy || !running.some(row => row.current)} title={copy('Stop every run of this worktree','停止此工作树中的所有运行')} onClick={() => void stopAll()}>{copy('Stop all','全部停止')}</button></header>
   {running.length === 0 ? <p className="wb-empty">{copy('No run is active in this project.','此项目当前没有运行中的进程。')}</p> : running.map(row => <section className={`wb-run-running${row.current ? ' current' : ''}`} key={row.session.id} data-testid="run-running-row" data-session-id={row.session.id} data-run-entry={row.commandId} data-current={row.current ? 'true' : undefined}>
    <div className="ql-command-head"><strong>{row.name}</strong><AgentTag startedBy={row.session.run?.startedBy} sessions={sessions} zh={chinese} onOpen={open}/><span className="ql-worktree" title={row.current ? copy('This worktree','此工作树') : row.worktree}>{row.worktree}</span><span className={`ql-state ql-${row.state.state}`} data-testid="run-running-state"><span className="dot" aria-hidden="true"/>{runStateLabel(row.state, chinese)}</span>{allocatedRunPort(row.session) !== undefined && <span className="ql-port" data-testid="run-port">:{allocatedRunPort(row.session)}</span>}<span className="ql-uptime" title={copy('Uptime','运行时长')}>{formatUptime(uptimeMs(row.session.createdAt, now))}</span></div>
    {row.state.url && <RunUrlLink url={row.state.url} onOpenPreview={actions.openPreview} pending={!previewReady(row.session)} zh={chinese}/>}
    <div className="ql-actions">
     <button type="button" className="btn btn-sm" data-testid="run-restart" disabled={busy} onClick={() => void restartRun(row.session)}>{copy('Restart','重启')}</button>
     <button type="button" className="btn btn-sm" data-testid="run-stop" disabled={busy} onClick={() => void stopRun(row.session)}>{copy('Stop','停止')}</button>
     <button type="button" className="btn btn-sm btn-ghost" data-run-primary="true" data-testid="run-open-output" disabled={busy} onClick={() => open(row.session.id)}>{copy('Open output','打开输出')}</button>
    </div>
   </section>)}
  </section>

  <RunSetupSection projectId={scope.projectId} root={root} commands={catalog.commands} sessions={projectSessions} zh={chinese} onOpenSession={open} onChanged={catalog.refresh}/>

  <section className="wb-run-section" data-testid="run-entries" aria-label={copy('Commands','命令')}>
   {catalog.commands.length + catalog.repo.entries.length + catalog.detected.length >= RUN_FILTER_FROM && <input className="wb-run-filter" type="search" data-testid="run-filter" value={filter} placeholder={copy('Filter entries','筛选条目')} aria-label={copy('Filter entries','筛选条目')} onChange={event => setFilter(event.target.value)}/>}
   {catalog.loading && !everything.length ? <p className="wb-empty" role="status">{copy('Loading commands…','正在加载命令…')}</p> : null}
   {!catalog.loading && !everything.length && !catalog.detecting ? <div className="wb-empty-state"><Play/><strong>{copy('Nothing to run yet','暂无运行项')}</strong><p>{copy('Save a command, import package.json scripts, or add a manifest this worktree can run.','保存一个命令、导入 package.json 脚本，或添加可运行的清单文件。')}</p></div> : null}
   {shown === 0 && everything.length > 0 ? <p className="wb-empty">{copy('No entry matches this filter.','没有条目匹配此筛选。')}</p> : null}
   {groups.map(group => <div className="wb-run-group" key={group.key} data-testid={`run-group-${group.key}`}>
    <button type="button" className="wb-run-group-head" aria-expanded={!collapsed.has(group.key)} onClick={() => toggleGroup(group.key)}>
     <span className={`wb-chevron${collapsed.has(group.key) ? '' : ' open'}`}><Icon name="chevR"/></span><span>{group.label}</span>{group.key === 'repo' && <span className="ql-source-label">.threadterm/run.json</span>}<span className="wb-count">{group.rows.length}</span>
    </button>
    {!collapsed.has(group.key) && (group.sub
     ? group.sub.map(section => <div className="wb-run-sub" key={section.name}><div className="ql-detected-group-head">{section.name}</div>{section.rows.map(entry => renderRow(entry))}</div>)
     : group.rows.map(entry => renderRow(entry)))}
   </div>)}
   {catalog.truncated && <p className="wb-hint">{copy('The detected list is partial.','检测到的列表不完整。')}</p>}
  </section>

  <footer className="wb-run-foot">
   <button type="button" className="menu-item" data-testid="run-import" disabled={busy} onClick={() => setImporting(true)}><Icon name="export"/>{copy('Import from package.json','从 package.json 导入')}</button>
  </footer>

  {editor && <CommandEditor key={editor === 'new' ? 'new' : 'revision' in editor ? editor.id : 'fingerprint' in editor ? `repo:${editor.id}` : `detected:${(editor as DetectedRunEntry).key}`}
   command={editor !== 'new' && 'revision' in editor ? editor : undefined} detected={editor !== 'new' && 'key' in editor ? editor as DetectedRunEntry : undefined} repo={editor !== 'new' && 'fingerprint' in editor ? editor : undefined} repoFingerprint={catalog.repo.fileFingerprint}
   projectId={scope.projectId} root={root}
   onClose={() => setEditor(undefined)} onChanged={async () => { catalog.refresh(); }}
   onReload={async commandId => (await request('quickLaunch.list', {projectId:scope.projectId})).find(command => command.id === commandId)}
   onRun={async command => { const result = await request('quickLaunch.run', { commandId:command.id, cwd:root, operationId:operationId() }); open(result.session.id); }}/>}
  {importing && <ImportScripts projectId={scope.projectId} root={root} onClose={() => setImporting(false)} onChanged={async () => { catalog.refresh(); }}/>}
 </div>;
}
