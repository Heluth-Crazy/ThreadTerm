import { useEffect, useRef, useState } from 'react';
import type { QuickLaunchSetup, Session, WorktreeSetupRun } from '@threadterm/protocol';
import { operationId, request, subscribeEvents } from '../bridge';
import { quickLaunchError } from '../quickLaunch';
import { setupActions, setupCurrentSessionId, setupStatusLine } from '../worktreeSetup';
import { setupRunForRoot } from '../runSequence';

/** Status belongs in the list; configuration belongs in the header's Worktree setup dialog. */
export function RunSetupSection({projectId,root,sessions,zh,onOpenSession,onChanged}:{projectId:string;root:string;commands:readonly import('@threadterm/protocol').QuickLaunchCommand[];sessions:readonly Session[];zh:boolean;onOpenSession:(id:string)=>void;onChanged:()=>void}) {
 const copy=(en:string,cn:string)=>zh?cn:en;
 const [setup,setSetup]=useState<QuickLaunchSetup>(),[runs,setRuns]=useState<WorktreeSetupRun[]>([]),[busy,setBusy]=useState(false),[issue,setIssue]=useState<string>();
 const generation=useRef(0);
 const refresh=async()=>{const token=++generation.current;try {const [nextSetup,nextRuns]=await Promise.all([request('quickLaunch.setup.read',{projectId}),request('quickLaunch.setup.status',{projectId})]);if(token===generation.current){setSetup(nextSetup);setRuns(nextRuns);}}catch(error){if(token===generation.current)setIssue(quickLaunchError(error,zh));}};
 useEffect(()=>{void refresh();const unsubscribe=subscribeEvents(event=>{const data=event.data as {kind?:unknown;projectId?:unknown}|undefined;if(event.event==='state.changed'&&data?.kind==='quickLaunch.setup'&&data.projectId===projectId)void refresh();});return()=>{generation.current++;unsubscribe();};},[projectId,zh]);
 const current=setupRunForRoot(runs,root),sessionId=setupCurrentSessionId(current,sessions),steps=setup?.commandIds.length??0;
 const perform=(task:()=>Promise<void>)=>void (async()=>{if(busy)return;setBusy(true);setIssue(undefined);try{await task();await refresh();onChanged();}catch(error){setIssue(quickLaunchError(error,zh));}finally{setBusy(false);}})();
 if(!steps)return issue?<p className="surface-error" role="alert">{issue}</p>:null;
 const run=(fromStep?:number)=>perform(async()=>{await request('quickLaunch.setup.run',{projectId,cwd:root,fromStep,operationId:operationId()});});
 return <section className="wb-run-section wb-run-setup" data-testid="run-setup-section" aria-label={copy('Setup','初始化')}>
  <div className="wb-run-setup-status" role="status">{current?<><span>{setupStatusLine(current,zh)}</span>{setupActions(current,sessionId).map(action=>action==='open'?<button key={action} type="button" className="btn btn-sm btn-ghost" disabled={!sessionId} onClick={()=>sessionId&&onOpenSession(sessionId)}>{copy('Open terminal','打开终端')}</button>:<button key={action} type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={()=>run(action==='retry'?current.step:undefined)}>{action==='retry'?copy('Retry from this step','从此步骤重试'):copy('Run again','再次运行')}</button>)}</>:<><span>{copy(`Setup: ${steps} step${steps===1?'':'s'}`,`初始化：${steps} 个步骤`)}</span><button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={()=>run()}>{copy('Run now','立即运行')}</button></>}</div>
  {issue&&<p className="surface-error" role="alert">{issue}</p>}
 </section>;
}
