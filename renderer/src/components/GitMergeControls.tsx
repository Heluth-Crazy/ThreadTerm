import { Select } from "./ui/Select";
import {useEffect,useRef,useState} from 'react';
import type {FileScope, GitStatus, LocalBranch} from '@threadterm/protocol';
import {operationId, request} from '../bridge';
import {useTranslation} from '../i18n';
import {SurfaceDialog} from './SurfaceDialog';
import {workbenchError} from '../workbench/errors';
import {mergeResultMessage} from '../workbench/gitOperation';

export function GitMergeControls({scope,operation,disabled,onChanged}:{scope:FileScope;operation?:GitStatus['operation'];disabled:boolean;onChanged:()=>Promise<void>}) {
  const {locale}=useTranslation(); const zh=locale==='zh-CN';
  const [branches,setBranches]=useState<LocalBranch[]>([]), [branch,setBranch]=useState('');
  const [opened,setOpened]=useState(false), [busy,setBusy]=useState(false), [issue,setIssue]=useState('');
  const [confirmation,setConfirmation]=useState<'merge'|'abort'>();
  const scopeKey=`${scope.projectId}\0${scope.worktreePath ?? ''}`;
  const currentScope=useRef(scopeKey);currentScope.current=scopeKey;
  useEffect(()=>{setOpened(false);setBranch('');setIssue('');setBusy(false);setConfirmation(undefined);},[scopeKey]);
  async function open() {
    setOpened(true);setIssue('');
    const key=scopeKey;
    try {const next=await request('worktree.branches',{projectId:scope.projectId});if(key===currentScope.current)setBranches(next.filter(item=>!item.current));}
    catch(error){if(key===currentScope.current)setIssue(workbenchError(error,zh));}
  }
  async function merge(abort=false) {
    setConfirmation(undefined);
    const key=scopeKey;
    setBusy(true);setIssue('');
    try {
      if(abort){await request('git.merge.abort',{...scope,operationId:operationId()});if(key===currentScope.current)setIssue(zh?'合并已中止。':'Merge aborted.');}
      else {const result=await request('git.merge',{...scope,branch,operationId:operationId()});if(key===currentScope.current)setIssue(mergeResultMessage(result,zh));}
      if(key===currentScope.current)await onChanged();
    }catch(error){if(key===currentScope.current){setIssue(workbenchError(error,zh));await onChanged();}}finally{if(key===currentScope.current)setBusy(false);}
  }
  return <div className="git-merge-controls">
    <button className="btn" disabled={busy||disabled} onClick={()=>void open()}>{zh?'合并分支…':'Merge branch…'}</button>
    {opened&&<><label>{zh?'来源分支':'Source branch'}<Select value={branch} onChange={event=>setBranch(event.target.value)}><option value="">{zh?'选择分支':'Choose branch'}</option>{branches.map(item=><option key={item.name} value={item.name}>{item.name}</option>)}</Select></label><button className="btn" disabled={busy||disabled||!branch} onClick={()=>setConfirmation('merge')}>{zh?'合并':'Merge'}</button>{operation?.kind==='merge'&&<button className="btn" disabled={busy||disabled} onClick={()=>setConfirmation('abort')}>{zh?'中止当前合并':'Abort current merge'}</button>}</>}
    {issue&&<p role="status">{issue}</p>}
    {confirmation&&<SurfaceDialog size="sm" icon="branch" title={confirmation==='abort'?(zh?'中止合并？':'Abort merge?'):(zh?'合并分支？':'Merge branch?')} onClose={()=>setConfirmation(undefined)}
      footer={<><button type="button" className="btn" onClick={()=>setConfirmation(undefined)}>{zh?'取消':'Cancel'}</button><button type="button" className={`btn ${confirmation==='abort'?'btn-danger':'btn-primary'}`} disabled={busy||disabled||(confirmation==='abort'&&operation?.kind!=='merge')} onClick={()=>void merge(confirmation==='abort')}>{confirmation==='abort'?(zh?'中止合并':'Abort merge'):(zh?'合并':'Merge')}</button></>}>
      <p>{confirmation==='abort'?(zh?'中止当前合并并还原合并开始前的状态？':'Abort this merge and restore the state before the merge?'):(zh?`将 ${branch} 合并到当前分支？`:`Merge ${branch} into the current branch?`)}</p>
    </SurfaceDialog>}
  </div>;
}
