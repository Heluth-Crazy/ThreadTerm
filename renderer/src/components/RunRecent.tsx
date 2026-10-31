import type { QuickLaunchCommand, QuickLaunchRecentRun, Session } from '@threadterm/protocol';
import { AgentTag } from './RunRows';
import { recentRunLabel } from '../runProposals';

function sourceLabel(source:QuickLaunchRecentRun['source'],zh:boolean):string {
 const labels:Record<string,[string,string]>={saved:['Saved','已保存'],detected:['Detected','检测到的'],repo:['Shared (repo)','共享（仓库）'],adhoc:['Ad hoc','临时']};
 return (labels[source]??labels.adhoc)[zh?1:0];
}

export function RunRecent({runs,commands,sessions,zh,busy,onKeep,onOpenChat}:{runs:readonly QuickLaunchRecentRun[];commands:readonly QuickLaunchCommand[];sessions:readonly Session[];zh:boolean;busy:boolean;onKeep:(run:QuickLaunchRecentRun)=>void;onOpenChat:(id:string)=>void}) {
 const copy=(en:string,cn:string)=>zh?cn:en;
 if(!runs.length)return null;
 return <details className="wb-run-section wb-run-recent" data-testid="run-recent" aria-label={copy('Recent','最近运行')}>
  <summary className="wb-run-section-head"><span className="wb-section-label">{copy('Recent','最近运行')}</span><span className="wb-count">{runs.length}</span></summary>
  {runs.map(run => {
   const current=commands.find(command=>command.id===run.entryId);
    const unchanged=run.source==='saved' && Boolean(current) && ['name','command','shell','cwd','kind','previewUrl'].every(key=>current![key as keyof QuickLaunchCommand]===run.snapshot[key as keyof QuickLaunchCommand]) && JSON.stringify(current?.env)===JSON.stringify(run.snapshot.env) && JSON.stringify(current?.dependsOn??[])===JSON.stringify(run.snapshot.dependsOn??[]) && !run.kept;
   return <article className="wb-recent-row" key={run.runId} data-testid="run-recent-row" data-run-id={run.runId}>
    <div className="ql-command-head"><strong>{run.name}</strong><span className="ql-source-label">{sourceLabel(run.source,zh)}</span><AgentTag startedBy={run.startedBy} sessions={sessions} zh={zh} onOpen={onOpenChat}/>{run.startedBy&&<span className="wb-agent-chat">{sessions.find(session=>session.id===run.startedBy)?.title??run.startedBy}</span>}<span className={`ql-state ql-${run.state}`}><span className="dot" aria-hidden="true"/>{recentRunLabel(run,zh)}</span></div>
    <code title={run.command}>{run.command}</code>
    {!unchanged && <div className="ql-actions">{run.kept ? <span className="wb-kept" title={run.kept.commandId}>{copy('Pinned','已固定')}</span> : <button type="button" className="btn btn-sm" data-testid="run-recent-keep" disabled={busy} onClick={()=>onKeep(run)}>{copy('Pin…','固定…')}</button>}</div>}
   </article>;
  })}
 </details>;
}
