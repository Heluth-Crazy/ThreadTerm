import { Select } from "./ui/Select";
import {useState} from 'react';
import type {FileScope, LocalBranch} from '@threadterm/protocol';
import {operationId, request} from '../bridge';
import {useTranslation} from '../i18n';

export function GitMergeControls({scope,disabled,onChanged}:{scope:FileScope;disabled:boolean;onChanged:()=>Promise<void>}) {
  const {locale}=useTranslation(); const zh=locale==='zh-CN';
  const [branches,setBranches]=useState<LocalBranch[]>([]), [branch,setBranch]=useState('');
  const [opened,setOpened]=useState(false), [busy,setBusy]=useState(false), [issue,setIssue]=useState('');
  async function open() {
    setOpened(true);setIssue('');
    try {setBranches((await request('worktree.branches',{projectId:scope.projectId})).filter(item=>!item.current));}
    catch(error){setIssue(String(error));}
  }
  async function merge(abort=false) {
    if(!confirm(abort?(zh?'中止当前合并并还原合并开始前的状态？':'Abort this merge and restore the state before the merge?'):(zh?`将 ${branch} 合并到当前分支？`:`Merge ${branch} into the current branch?`)))return;
    setBusy(true);setIssue('');
    try {
      if(abort){await request('git.merge.abort',{...scope,operationId:operationId()});setIssue(zh?'合并已中止。':'Merge aborted.');}
      else {const result=await request('git.merge',{...scope,branch,operationId:operationId()});setIssue(result.conflicted?(zh?'合并有冲突。请从改动列表打开文件，解决冲突后保存、暂存并提交。':'Merge has conflicts. Open the changed files, resolve and save them, then stage and commit.'):(zh?'合并已完成。':'Merge completed.'));}
      await onChanged();
    }catch(error){setIssue(String(error));await onChanged();}finally{setBusy(false);}
  }
  return <div className="git-merge-controls">
    <button disabled={busy||disabled} onClick={()=>void open()}>{zh?'合并分支…':'Merge branch…'}</button>
    {opened&&<><label>{zh?'来源分支':'Source branch'}<Select value={branch} onChange={event=>setBranch(event.target.value)}><option value="">{zh?'选择分支':'Choose branch'}</option>{branches.map(item=><option key={item.name} value={item.name}>{item.name}</option>)}</Select></label><button disabled={busy||disabled||!branch} onClick={()=>void merge()}>{zh?'合并':'Merge'}</button><button disabled={busy||disabled} onClick={()=>void merge(true)}>{zh?'中止当前合并':'Abort current merge'}</button></>}
    {issue&&<p role="status">{issue}</p>}
  </div>;
}
