import { useRef, useState } from 'react';
import type { BrowserTabOperation } from '../browserTypes';
import { browserOperationActive, browserOperationName, browserOperationStatus, canStopBrowserOperation, recentBrowserOperations } from '../browserAgentUi';
import './browser-tab-activity.css';

export function BrowserTabActivity({operations,zh,onStop}:{operations:readonly BrowserTabOperation[];zh:boolean;onStop:(operationId:string)=>Promise<void>}) {
 const [pending,setPending]=useState<ReadonlySet<string>>(new Set()),[issue,setIssue]=useState(false);
 const pendingRef=useRef(new Set<string>());
 const copy=(en:string,cn:string)=>zh?cn:en,recent=recentBrowserOperations(operations);
 const current=recent.find(browserOperationActive)??recent[0];
 if(!current)return null;
 const stop=async(operation:BrowserTabOperation)=>{
  if(!canStopBrowserOperation(operation)||pendingRef.current.has(operation.operationId))return;
  if(pendingRef.current.size>=50){setIssue(true);return;}
  setIssue(false);pendingRef.current.add(operation.operationId);setPending(new Set(pendingRef.current));
  try{await onStop(operation.operationId);}catch{setIssue(true);}
  finally{pendingRef.current.delete(operation.operationId);setPending(new Set(pendingRef.current));}
 };
 const stopButton=(operation:BrowserTabOperation)=>canStopBrowserOperation(operation)||pending.has(operation.operationId)?<button type="button" className="btn btn-sm btn-ghost" disabled={pending.has(operation.operationId)}
  aria-label={`${copy('Stop','停止')} ${browserOperationName(operation.tool,copy)} · ${copy('Chat','对话')} ${operation.callerSessionId}`}
  onClick={()=>void stop(operation)}>{pending.has(operation.operationId)?copy('Stopping…','正在停止…'):copy('Stop','停止')}</button>:null;
 return <section className="browser-tab-activity" aria-label={copy('Agent browser activity','智能体浏览器操作')}>
  <div className="browser-tab-activity-current"><p role="status" aria-live="polite" aria-atomic="true">
   <strong>{browserOperationName(current.tool,copy)}</strong> · {browserOperationStatus(current,copy)} · <span>{copy('Chat','对话')} {current.callerSessionId}</span>
  </p>{stopButton(current)}</div>
  <details><summary>{copy(`Recent operations (${recent.length})`,`最近操作（${recent.length}）`)}</summary><ol>
   {recent.map(operation=><li key={operation.operationId} data-operation-id={operation.operationId} data-operation-phase={operation.phase}>
    <div><strong>{browserOperationName(operation.tool,copy)}</strong> · <span>{browserOperationStatus(operation,copy)}</span>
     <p>{copy('Chat','对话')} {operation.callerSessionId}</p>
     {operation.origin&&<p title={operation.title}>{operation.origin}</p>}
     {operation.provenanceUnavailable&&<p>{copy('Page provenance unavailable','页面来源信息不可用')}</p>}
    </div>{stopButton(operation)}
   </li>)}
  </ol></details>
  {issue&&<p className="surface-error" role="alert">{copy('Could not stop this operation. Try again.','无法停止此操作，请重试。')}</p>}
 </section>;
}
