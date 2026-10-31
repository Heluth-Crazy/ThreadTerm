import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DetectedRunEntry, QuickLaunchCommand, QuickLaunchRecentRun, RunProposal, Session } from '@threadterm/protocol';
import type { QuickLaunchRepoEntry } from '@threadterm/protocol';
 import { operationId, request, subscribeEvents } from '../bridge';
import { useTranslation } from '../i18n';
import { detectedSections, detectedGroupLabel, missingToolLabel, previewReady, quickLaunchError, runStateLabel } from '../quickLaunch';
import { useVisibleTicker } from '../visibleTicker';
import { isKeyboardEditableTarget } from '../workbench/scmKeyboard';
import type { WorkbenchActions, WorkbenchScope } from '../workbench/types';
import {
 filterRunEntries, formatUptime, runCurrentConfigs, runningRows, RUN_FILTER_FROM, uptimeMs, useRunCurrentEntry, runShortcutLabel,
} from '../workbench/runView';
import { CommandEditor, ImportScripts, SetupEditor } from './QuickLaunch';
import { RunSetupSection } from './RunSetupSection';
import { activeSequenceForCommand, allocatedRunPort, sequenceChipText } from '../runSequence';
import { Icon } from './PrototypeIcon';
import { showContextMenu } from './ContextMenu';
import { detectedRunEntries, AgentTag, isPinnedDetectedTwin, Play, repoRunEntries, RunEntryRow, RunUrlLink, runEntrySessions, savedRunEntries, unpinNeedsConfirm, useRunCatalog, type RunEntry } from './RunRows';
 import { RunRepoDetails } from './RunRepoDetails';
import { useRecentRuns, useRunProposals } from '../runProposals';
import { RunRecent } from './RunRecent';
import { RunProposals } from './RunProposals';
import './quick-launch.css';
import './run-view.css';
import { createRunController } from '../workbench/runController';

/** Dense launch entries for this worktree and active processes across the project, with explicit output actions. */
export function RunViewPanel({scope, sessions, actions, zh, visible, toolbarHost}:{
 scope:WorkbenchScope;
 /** Every session of the runtime snapshot; the view filters to this project so other worktrees' runs are listed. */
 sessions:Session[];
 actions:WorkbenchActions;
 zh:boolean;
 visible:boolean;
 toolbarHost?:HTMLElement;
}) {
 const { locale } = useTranslation(), chinese = zh || locale === 'zh-CN';
 const copy = (en:string, cn:string) => chinese ? cn : en;
 const root = scope.rootPath, runScope = { projectId:scope.projectId, root };
 const projectSessions = useMemo(() => sessions.filter(session => session.projectId === scope.projectId), [sessions, scope.projectId]);
 const sessionIds = useMemo(() => new Set(projectSessions.map(session => session.id)), [projectSessions]);
 const sessionKey=useMemo(()=>projectSessions.map(session=>`${session.id}:${session.status}:${session.updatedAt}`).join('|'),[projectSessions]);
 const catalog = useRunCatalog({ projectId:scope.projectId, root, live:visible, zh:chinese, sessionIds });
 const recent = useRecentRuns({projectId:scope.projectId,root}, visible, chinese, sessionIds, sessionKey);
 const proposals = useRunProposals({projectId:scope.projectId,root}, visible, chinese);
 const [busy, setBusy] = useState(false);
 const [issue, setIssue] = useState<string>();
 const [filter, setFilter] = useState('');
 const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
 const [now, setNow] = useState(() => Date.now());
 const [, setConfigRevision] = useState(0);
 const [editor, setEditor] = useState<QuickLaunchCommand|'new'|DetectedRunEntry|QuickLaunchRepoEntry>();
 const [keepRun,setKeepRun]=useState<{run:QuickLaunchRecentRun;command?:QuickLaunchCommand}>();
 const [proposal,setProposal]=useState<RunProposal>();
 const [importing, setImporting] = useState(false);
 const [setupEditor,setSetupEditor]=useState(false);
 const [sequenceRuns, setSequenceRuns] = useState<import('@threadterm/protocol').WorktreeSetupRun[]>([]);
 // Uptime is the only timer: one tick per second, only while this view is visible.
 useVisibleTicker(() => setNow(Date.now()), visible);
 const running = useMemo(() => runningRows(projectSessions, runScope), [projectSessions, scope.projectId, root]);
 const controller=useMemo(()=>createRunController(runScope,projectSessions),[runScope.projectId,runScope.root,projectSessions]);
 const saved = savedRunEntries(catalog.commands);
 const detected = detectedRunEntries(catalog.detected).filter(entry=>!catalog.commands.some(command=>entry.detected&&isPinnedDetectedTwin(command,entry.detected)));
 const repo = repoRunEntries(catalog.repo.entries);
 const everything = [...saved, ...repo, ...detected];
 const current = useRunCurrentEntry(runScope,projectSessions);
 useEffect(() => { if (!visible) return; let active=true; const refresh=()=>{void request('quickLaunch.setup.status',{projectId:scope.projectId}).then(value=>{if(active)setSequenceRuns(value);}).catch(()=>{});}; refresh(); const unsubscribe=subscribeEvents(event=>{const data=event.data as {kind?:unknown;projectId?:unknown}|undefined;if(event.event==='state.changed'&&data?.kind==='quickLaunch.setup'&&data.projectId===scope.projectId)refresh();}); return()=>{active=false;unsubscribe();}; }, [visible,scope.projectId]);

 const perform = async (task:() => Promise<void>) => {
  if (busy) return;
  setBusy(true); setIssue(undefined);
  try { await task(); }
  catch (error) { setIssue(quickLaunchError(error, chinese)); }
  finally { setBusy(false); }
 };
 const open = (sessionId:string) => actions.openSession?.(sessionId);
 const runEntry = (entry:RunEntry) => perform(async () => { await controller.run(entry.commandId); });
 const stopRun = (session:Session) => perform(async () => { await controller.stop(session.id); });
 const restartRun = (session:Session) => perform(async () => { await controller.restart(session.id); });
 const stopAll = () => perform(async () => { await controller.stopAll(); });
 const rejectProposal=(item:RunProposal)=>perform(async()=>{await request('quickLaunch.proposals.reject',{proposalId:item.id,operationId:operationId()});await proposals.reload();});
 const setCurrent = (entry:RunEntry) => {
  runCurrentConfigs.choose(runScope, { commandId:entry.commandId, name:entry.name, source:entry.source });
  setConfigRevision(value => value + 1);
 };

 const pin = (entry:RunEntry) => perform(async()=>{
  if(entry.source==='repo')return;
  if(entry.source==='saved'){
   const twin=catalog.detected.find(item=>isPinnedDetectedTwin(entry.saved!,item));
   if(unpinNeedsConfirm(entry.saved!,twin)&&!confirm(copy(`Delete “${entry.name}”? It has settings that aren't in the project files.`,`删除“${entry.name}”？它包含项目文件中没有的设置。`)))return;
   await request('quickLaunch.delete',{id:entry.saved!.id,expectedRevision:entry.saved!.revision,operationId:operationId()});
  }else await request('quickLaunch.save',{projectId:scope.projectId,name:entry.name,command:entry.command,shell:entry.detected!.shell,cwd:entry.cwd,kind:entry.kind,env:[],operationId:operationId()});
  catalog.refresh();
 });
 const currentSession=running.find(row=>row.current&&row.commandId===current?.commandId)?.session;
 const currentAction=(action:'run'|'stop'|'restart')=>perform(async()=>{
  if(!current)return;
  if(action==='stop'){if(currentSession)await controller.stop(currentSession.id);}
  else if(action==='restart'&&currentSession)await controller.restart(currentSession.id);
  else await controller.run(current.commandId);
 });
 const rowMenu = (entry:RunEntry, session:Session|undefined, event:React.MouseEvent<HTMLElement>) => {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const isCurrent = current?.commandId === entry.commandId;
  const latest=runEntrySessions(projectSessions,entry.commandId,root).latest;
  showContextMenu({
   x:box.left, y:box.bottom, restoreFocus:event.currentTarget as HTMLElement,
   items:[
    { id:'run', label:session ? copy('Open output', '打开输出') : copy('Run','运行'), disabled:busy || Boolean(entry.missingTool), reason:entry.missingTool, onSelect:() => session ? open(session.id) : runEntry(entry) },
    ...(!session&&latest?[{id:'output',label:copy('Open output','打开输出'),onSelect:()=>open(latest.id)}]:[]),
    { id:'current', label:copy('Use for Run button','用于运行按钮'), shortcut:isCurrent ? copy('Current','当前') : undefined, disabled:isCurrent, onSelect:() => setCurrent(entry) },
    ...(session ? [
     { id:'restart', label:copy('Restart','重启'), disabled:busy, onSelect:() => restartRun(session) },
     { id:'stop', label:copy('Stop','停止'), disabled:busy, onSelect:() => stopRun(session) },
    ] : []),
    { id:'separator', label:'', separator:true },
    entry.source === 'detected'
     ? { id:'save', label:copy('Edit and pin…','编辑并固定…'), disabled:busy, onSelect:() => setEditor(entry.detected!) }
     : entry.source === 'repo'
      ? { id:'edit', label:copy('Edit…','编辑…'), disabled:busy, onSelect:() => setEditor(entry.repo!) }
      : { id:'edit', label:copy('Edit…','编辑…'), disabled:busy, onSelect:() => setEditor(entry.saved!) },
    ...(entry.source==='repo'?[]:[{id:'pin',label:entry.source==='saved'?copy('Unpin','取消固定'):copy('Pin','固定'),disabled:busy,onSelect:()=>pin(entry)}]),
    { id:'copy', label:copy('Copy command','复制命令'), onSelect:()=>perform(async()=>{await navigator.clipboard.writeText(entry.command);}) },
    ...(entry.source==='saved'?[{id:'delete',label:copy('Delete…','删除…'),danger:true,disabled:busy,onSelect:()=>{if(confirm(copy(`Delete “${entry.name}”?`,`删除“${entry.name}”？`)))void perform(async()=>{await request('quickLaunch.delete',{id:entry.saved!.id,expectedRevision:entry.saved!.revision,operationId:operationId()});catalog.refresh();});}}]:[]),
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
 const visibleDetected=catalog.detected.filter(entry=>!entry.missingTool&&!catalog.commands.some(command=>isPinnedDetectedTwin(command,entry)));
 const base:{key:string;label:string;rows:RunEntry[]}[] = [
  ...(saved.length?[{key:'saved',label:copy('Pinned','已固定'),rows:saved}]:[]),
  ...(repo.length?[{key:'repo',label:copy('Shared · run.json','共享 · run.json'),rows:repo}]:[]),
  ...detectedSections(visibleDetected).flatMap(section=>section.groups.map(group=>{return {key:`detected:${section.kind}:${group.name}`,label:detectedGroupLabel(group.entries[0],chinese),rows:detectedRunEntries(group.entries)};})),
 ];
 const groups = base.map(group => {
  if (!filter.trim()) return group;
  return {
   ...group,
   rows:filterRunEntries(group.rows.map(entry=>({...entry,detail:group.label})), filter),
  };
 }).filter(group => group.rows.length);
 const shown = groups.reduce((total, group) => total + group.rows.length, 0);

 const renderRow = (entry:RunEntry) => {
  const { active,latest } = runEntrySessions(projectSessions, entry.commandId, root);
  const sequence=activeSequenceForCommand(sequenceRuns,root,entry.commandId);
  return <RunEntryRow key={entry.commandId} entry={entry} session={active} latest={latest} zh={chinese} busy={busy} onOpen={open} onRun={()=>void runEntry(entry)}
   current={current?.commandId === entry.commandId} sequenceText={sequenceChipText(sequence,chinese)}
   onCancelSequence={sequence?.state==='running'?()=>void perform(async()=>{await request('quickLaunch.sequence.cancel',{id:sequence.id,operationId:operationId()});}):undefined}
    details={entry.repo ? <RunRepoDetails entry={entry.repo} zh={chinese} busy={busy} onEdit={() => setEditor(entry.repo!)} onTrust={() => void perform(async () => { await request('quickLaunch.repo.trust',{projectId:scope.projectId,cwd:root,id:entry.repo!.id,fingerprint:entry.repo!.fingerprint,operationId:operationId()}); catalog.refresh(); })}/> : undefined}
   actions={<>
    {entry.source!=='repo'&&!active&&!entry.missingTool&&<button type="button" className={`icon-btn wb-run-pin${entry.source==='saved'?' is-pinned':''}`} data-testid={`run-pin-${entry.key}`} aria-label={entry.source==='saved'?`${copy('Unpin','取消固定')} ${entry.name}`:`${copy('Pin','固定')} ${entry.name}`} title={entry.source==='saved'?copy('Unpin','取消固定'):copy('Pin','固定')} disabled={busy} onClick={()=>void pin(entry)}><Icon name="star"/></button>}
    {active&&<><button type="button" className="icon-btn" aria-label={`${copy('Restart','重启')} ${entry.name}`} title={copy('Restart','重启')} disabled={busy} onClick={()=>void restartRun(active)}><span aria-hidden="true">⟳</span></button><button type="button" className="icon-btn" aria-label={`${copy('Stop','停止')} ${entry.name}`} title={copy('Stop','停止')} disabled={busy} onClick={()=>void stopRun(active)}><span aria-hidden="true">■</span></button></>}
    <button type="button" className="icon-btn" data-testid={`run-row-menu-${entry.key}`} aria-label={`${copy('More actions','更多操作')} ${entry.name}`} aria-haspopup="menu" title={copy('More actions','更多操作')} onClick={event => rowMenu(entry, active, event)}><Icon name="more"/></button>
   </>}/>;
 };

 const toolbar=<><button type="button" className="icon-btn" data-testid="run-new-command" aria-label={copy('New command','新建命令')} title={copy('New command','新建命令')} onClick={()=>setEditor('new')}><Icon name="plus"/></button><button type="button" className="icon-btn" data-testid="run-view-menu" aria-label={copy('Run view options','运行视图选项')} title={copy('Run view options','运行视图选项')} onClick={event=>{const box=event.currentTarget.getBoundingClientRect();showContextMenu({x:box.left,y:box.bottom,restoreFocus:event.currentTarget,items:[{id:'setup',label:copy('Worktree setup…','工作树初始化…'),onSelect:()=>setSetupEditor(true)},{id:'import',label:copy('Import from package.json…','从 package.json 导入…'),onSelect:()=>setImporting(true)},{id:'refresh',label:copy('Refresh','刷新'),onSelect:catalog.refresh},...(['run','stop','restart'] as const).map(action=>({id:`current-${action}`,label:copy(`${action==='run'?'Run':action==='stop'?'Stop':'Restart'} ${current?.name??''}`,`${action==='run'?'运行':action==='stop'?'停止':'重启'} ${current?.name??''}`).trim(),shortcut:runShortcutLabel(action),disabled:busy||!current||(action==='stop'&&!currentSession),reason:!current?copy('Choose an entry for the Run button first.','请先为运行按钮选择一个条目。'):action==='stop'&&!currentSession?copy('This entry is not running.','此条目未在运行。'):undefined,onSelect:()=>currentAction(action),testId:`run-current-${action}`}))]});}}><Icon name="more"/></button></>;
 return <div className="wb-run" data-testid="run-view" data-run-scope={`${scope.projectId}\0${root}`} onKeyDown={roveRows}>
  {toolbarHost?createPortal(toolbar,toolbarHost):toolbar}
  {(issue ?? catalog.issue) && <p className="wb-issue" role="alert">{issue ?? catalog.issue}</p>}

  {proposals.pending.length>0&&<RunProposals proposals={proposals.pending} sessions={sessions} zh={chinese} busy={busy}
   onAccept={item=>setProposal(item)} onReject={item=>void rejectProposal(item)} onOpenChat={open}/>}
  {saved.length + repo.length + visibleDetected.length >= RUN_FILTER_FROM && <input className="wb-run-filter" type="search" data-testid="run-filter" value={filter} placeholder={copy('Filter entries','筛选条目')} aria-label={copy('Filter entries','筛选条目')} onChange={event => setFilter(event.target.value)}/>}
  {running.length>0&&<section className="wb-run-section" data-testid="run-running" aria-label={copy('Running','运行中')}>
   <header className="wb-run-section-head"><span className="wb-section-label">{copy('Running','运行中')}</span><span className="wb-count">{running.length}</span>
    {running.filter(row=>row.current).length>=2&&<button type="button" className="icon-btn" data-testid="run-stop-all" disabled={busy} aria-label={copy('Stop all','全部停止')} title={copy('Stop all','全部停止')} onClick={() => void stopAll()}><span aria-hidden="true">■</span></button>}</header>
   {running.map(row => <section className={`wb-run-running${row.current ? ' current' : ''}`} key={row.session.id} data-testid="run-running-row" data-session-id={row.session.id} data-run-entry={row.commandId} data-current={row.current ? 'true' : undefined}>
    <div className="ql-command-head"><button type="button" className="wb-run-row-name" onClick={()=>open(row.session.id)}><span className={`dot ql-${row.state.state}`} data-testid="run-running-state" data-state={row.state.state} title={runStateLabel(row.state,chinese)} aria-label={runStateLabel(row.state,chinese)}/><strong>{row.name}</strong></button><AgentTag startedBy={row.session.run?.startedBy} sessions={sessions} zh={chinese} onOpen={open}/>{!row.current&&<span className="ql-worktree" title={row.worktree}>{row.worktree}</span>}{!row.state.url&&allocatedRunPort(row.session) !== undefined && <span className="ql-port" data-testid="run-port">:{allocatedRunPort(row.session)}</span>}<span className="ql-uptime" title={copy('Uptime','运行时长')}>{formatUptime(uptimeMs(row.session.createdAt, now))}</span></div>
    {row.state.url && <RunUrlLink url={row.state.url} compact onOpenPreview={actions.openPreview} pending={!previewReady(row.session)} zh={chinese}/>}
    <div className="ql-actions">
     <button type="button" className="icon-btn" data-testid="run-restart" aria-label={copy('Restart','重启')} title={copy('Restart','重启')} disabled={busy} onClick={() => void restartRun(row.session)}><span aria-hidden="true">⟳</span></button>
     <button type="button" className="icon-btn" data-testid="run-stop" aria-label={copy('Stop','停止')} title={copy('Stop','停止')} disabled={busy} onClick={() => void stopRun(row.session)}><span aria-hidden="true">■</span></button>
    </div>
   </section>)}
  </section>}

  <RunSetupSection projectId={scope.projectId} root={root} commands={catalog.commands} sessions={projectSessions} zh={chinese} onOpenSession={open} onChanged={catalog.refresh}/>

  <section className="wb-run-section" data-testid="run-entries" aria-label={copy('Commands','命令')}>
   {catalog.loading && !everything.length ? <p className="wb-empty" role="status">{copy('Loading commands…','正在加载命令…')}</p> : null}
      {filter.trim() && shown === 0 ? <p className="wb-empty">{copy('No entry matches this filter.','没有条目匹配此筛选。')}</p> : null}
   {groups.map(group => <div className="wb-run-group" key={group.key} data-testid={`run-group-${group.key}`}>
    <button type="button" className="wb-run-group-head" aria-expanded={!collapsed.has(group.key)} onClick={() => toggleGroup(group.key)}>
     <span className={`wb-chevron${collapsed.has(group.key) ? '' : ' open'}`}><Icon name="chevR"/></span><span>{group.label}</span><span className="wb-count">{group.rows.length}</span>
    </button>
    {!collapsed.has(group.key) && group.rows.map(entry => renderRow(entry))}
   </div>)}
   {catalog.truncated && <p className="wb-hint">{copy('The detected list is partial.','检测到的列表不完整。')}</p>}
   {catalog.detected.some(entry=>entry.missingTool)&&<details className="wb-hint wb-run-unavailable" data-testid="run-unavailable"><summary>{copy(`Not found on PATH: ${Object.entries(catalog.detected.filter(entry=>entry.missingTool).reduce<Record<string,number>>((counts,entry)=>({...counts,[entry.missingTool!]:(counts[entry.missingTool!]??0)+1}),{})).map(([tool,count])=>`${tool} (${count})`).join(', ')}`,`PATH 中找不到：${Object.entries(catalog.detected.filter(entry=>entry.missingTool).reduce<Record<string,number>>((counts,entry)=>({...counts,[entry.missingTool!]:(counts[entry.missingTool!]??0)+1}),{})).map(([tool,count])=>`${tool}（${count}）`).join('、')}`)}</summary>{catalog.detected.filter(entry=>entry.missingTool).map(entry=><div key={entry.key} className="wb-run-unavailable-row" aria-disabled="true" title={missingToolLabel(entry.missingTool!,chinese)}><span>{entry.name}</span><span>{missingToolLabel(entry.missingTool!,chinese)}</span></div>)}</details>}
  </section>

  <RunRecent runs={recent.runs} commands={catalog.commands} sessions={sessions} zh={chinese} busy={busy} onOpenChat={open}
   onKeep={run=>setKeepRun({run,command:run.source==='saved'?catalog.commands.find(command=>command.id===run.entryId):undefined})}/>


  {editor && <CommandEditor key={editor === 'new' ? 'new' : 'revision' in editor ? editor.id : 'fingerprint' in editor ? `repo:${editor.id}` : `detected:${(editor as DetectedRunEntry).key}`}
   command={editor !== 'new' && 'revision' in editor ? editor : undefined} detected={editor !== 'new' && 'key' in editor ? editor as DetectedRunEntry : undefined} repo={editor !== 'new' && 'fingerprint' in editor ? editor : undefined} repoFingerprint={catalog.repo.fileFingerprint}
   projectId={scope.projectId} root={root}
   onClose={() => setEditor(undefined)} onChanged={async () => { catalog.refresh(); }}
   onReload={async commandId => (await request('quickLaunch.list', {projectId:scope.projectId})).find(command => command.id === commandId)}
   onRun={async command=>{await controller.run(command.id);}}/>}
  {keepRun && <CommandEditor key={`keep:${keepRun.run.runId}`} command={keepRun.command} initial={keepRun.run.source==='repo'?{...keepRun.run.snapshot,env:keepRun.run.snapshot.env.filter(row=>!row.secret)}:keepRun.run.snapshot} runId={keepRun.run.runId}
   projectId={scope.projectId} root={root} onClose={()=>setKeepRun(undefined)} onChanged={async()=>{catalog.refresh();await recent.reload();}}
   onReload={async commandId=>(await request('quickLaunch.list',{projectId:scope.projectId})).find(command=>command.id===commandId)}
   onRun={async command=>{await controller.run(command.id);}}/>}
  {proposal && <CommandEditor key={`proposal:${proposal.id}`} command={proposal.target} proposal={proposal}
   projectId={scope.projectId} root={root} onClose={()=>setProposal(undefined)} onChanged={async()=>{catalog.refresh();await proposals.reload();}}
   onReload={async commandId=>(await request('quickLaunch.list',{projectId:scope.projectId})).find(command=>command.id===commandId)}
   onRun={async()=>{}}/>}
  {importing && <ImportScripts projectId={scope.projectId} root={root} onClose={() => setImporting(false)} onChanged={async () => { catalog.refresh(); }}/>}
  {setupEditor&&<SetupEditor projectId={scope.projectId} commands={catalog.commands} onClose={()=>setSetupEditor(false)} onSaved={async()=>{catalog.refresh();}}/>}
 </div>;
}
