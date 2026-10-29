import type { GitStatus, RequestResult } from '@threadterm/protocol';
import { changeGroups, isConflict } from './gitDecorations';
import { workbenchError } from './errors';

export function mergeResultMessage(result:Pick<RequestResult<'git.merge'>,'conflicted'|'warning'>, zh:boolean):string {
 const warning=result.warning ? workbenchError(result.warning,zh) : undefined;
 if(result.conflicted) {
  const conflict=zh
   ? '合并有冲突。请从更改列表打开文件，解决冲突后保存、暂存，然后选择“完成合并”。'
   : 'Merge has conflicts. Open the changed files, resolve and save them, then stage them and choose Conclude merge.';
  return warning ? `${conflict} ${warning}` : conflict;
 }
 return warning ?? (zh ? '合并已完成。' : 'Merge completed.');
}

export function gitOperationState(status:GitStatus, zh:boolean) {
 const operation=status.operation;
 if(!operation) return undefined;
 const conflicts=status.changes.filter(isConflict).length;
 const canConclude=operation.kind==='merge' && conflicts===0 && status.changes.some(change=>changeGroups(change).includes('staged'));
 const canContinue=(operation.kind==='cherry-pick'||operation.kind==='revert') && conflicts===0;
 const head=operation.head?.trim();
 const target=head ? (/^[a-f0-9]{40,64}$/i.test(head) ? head.slice(0,7) : head) : status.branch ?? 'HEAD';
 const names={rebase:zh?'变基':'Rebase', 'cherry-pick':zh?'拣选':'Cherry-pick', revert:zh?'还原':'Revert'};
 const subject=operation.message?.trim();
 return {kind:operation.kind,canConclude,canContinue, conflicts, label:operation.kind==='merge'
  ? zh ? `正在合并 ${target} · ${conflicts} 个冲突` : `Merging ${target} · ${conflicts} conflicts`
  : operation.kind==='cherry-pick' ? zh ? `正在拣选 ${target}${subject?` “${subject}”`:''}` : `Cherry-picking ${target}${subject?` '${subject}'`:''}`
  : operation.kind==='revert' ? zh ? `正在还原 ${target}${subject?` “${subject}”`:''}` : `Reverting ${target}${subject?` '${subject}'`:''}`
  : zh ? `${names[operation.kind]}进行中，请在终端中完成或中止。` : `${names[operation.kind]} in progress; finish or abort it in a terminal.`};
}

export function pullDivergence(error:unknown) {
 const match=/\bpull_diverged:\s*(\d+)\s+(\d+)\b/.exec(error instanceof Error ? error.message : String(error));
 return match ? {ahead:Number(match[1]), behind:Number(match[2])} : undefined;
}
