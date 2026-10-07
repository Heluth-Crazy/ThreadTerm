import { lineRangeLabel } from './contextMenuActions';
export type SurfaceMenuItem = { id:string; label:string; disabled?:boolean; reason?:string; separator?:boolean; danger?:boolean };

const copy = (zh:boolean, en:string, cn:string) => zh ? cn : en;
const busyReason = (zh:boolean) => copy(zh, 'Another Git action is running.', '另一个 Git 操作正在进行。');

/** Pure policy for a Source Control row; renderers attach the existing callbacks and icons. */
export function sourceControlMenuItems({zh, staged, conflict, discardable, busy, canSend}:{zh:boolean;staged:boolean;conflict:boolean;discardable:boolean;busy:boolean;canSend:boolean}):SurfaceMenuItem[] {
 const unavailable = copy(zh, 'Open a Chat session in this workspace first.', '请先在此工作区打开一个聊天会话。');
 return [
  {id:'source-control-send-diff',label:copy(zh,'Send diff to agent','将差异发送给 Agent'),disabled:!canSend,reason:!canSend?unavailable:undefined},
  {id:staged?'source-control-unstage':'source-control-stage',label:staged?copy(zh,'Unstage','取消暂存'):conflict?copy(zh,'Mark resolved (stage)','标记已解决（暂存）'):copy(zh,'Stage','暂存'),disabled:busy,reason:busy?busyReason(zh):undefined},
  {id:'source-control-open-changes',label:copy(zh,'Open changes','查看更改')},
  {id:'source-control-copy-path',label:copy(zh,'Copy path','复制路径')},
  ...(discardable?[{id:'source-control-separator',label:'',separator:true},{id:'source-control-discard',label:copy(zh,'Discard changes','丢弃更改'),danger:true,disabled:busy,reason:busy?busyReason(zh):undefined}]:[]),
 ];
}

export function historyCommitMenuItems({zh,canSend}:{zh:boolean;canSend:boolean}):SurfaceMenuItem[] {
 return [
  {id:'history-send-to-agent',label:copy(zh,'Send commit to agent','将提交发送给 Agent'),disabled:!canSend,reason:!canSend?copy(zh,'Open a Chat session in this workspace first.','请先在此工作区打开一个聊天会话。'):undefined},
  {id:'history-copy-commit-hash',label:copy(zh,'Copy commit hash','复制提交哈希')},
 ];
}

export function historyVersionMenuItems({zh,startLine,endLine,canComment,commentReason,hasText,path}:{zh:boolean;startLine?:number;endLine?:number;canComment:boolean;commentReason?:string;hasText:boolean;path?:string}):SurfaceMenuItem[] {
 const range=startLine ? { en: lineRangeLabel(false,startLine,endLine??startLine), zh: lineRangeLabel(true,startLine,endLine??startLine) } : undefined;
 return [
  {id:'history-comment-lines',label:range?copy(zh,`Comment on ${range.en}`,`评论${range.zh}`):copy(zh,'Comment on selected lines','评论选中的行'),disabled:!canComment,reason:!canComment?(commentReason??copy(zh,'Comments are unavailable for this file version.','此文件版本无法评论。')):undefined},
  {id:'history-copy-selection',label:copy(zh,'Copy','复制'),disabled:!hasText,reason:!hasText?copy(zh,'Select text first.','请先选择文本。'):undefined},
  ...(path?[{id:'history-copy-path',label:copy(zh,'Copy path','复制路径')}]:[]),
 ];
}

export function fileTabMenuItems({zh,canSend,plansLabel,canCopy}:{zh:boolean;canSend:boolean;plansLabel?:string;canCopy:boolean}):SurfaceMenuItem[] {
 return [
  ...(canSend?[{id:'workspace-tab-send-file',label:copy(zh,'Send file to agent','将文件发送给 Agent')}]:[]),
  ...(plansLabel?[{id:'workspace-tab-plans-docs',label:plansLabel}]:[]),
  ...(canCopy?[{id:'workspace-tab-copy-path',label:copy(zh,'Copy path','复制路径')}]:[]),
 ];
}

export function explorerFileMenuItems({zh,canHistory,canSend,plansLabel}:{zh:boolean;canHistory:boolean;canSend:boolean;plansLabel?:string}):SurfaceMenuItem[] {
 return [
  ...(canHistory?[{id:'explorer-file-history',label:copy(zh,'File history','文件历史')}]:[]),
  ...(canSend?[{id:'explorer-send-to-agent',label:copy(zh,'Send to agent','发送给 Agent')}]:[]),
  ...(plansLabel?[{id:'explorer-plans-docs',label:plansLabel}]:[]),
  {id:'explorer-copy-path',label:copy(zh,'Copy path','复制路径')},
 ];
}
