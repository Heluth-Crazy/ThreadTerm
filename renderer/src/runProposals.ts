import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuickLaunchCommand, QuickLaunchRecent, QuickLaunchRecentRun, RunProposal, RunProposalList } from '@threadterm/protocol';
import { request, subscribeEvents } from './bridge';
import { quickLaunchError } from './quickLaunch';
import { visibleControlCharacters } from './chatQuestion';

export type ProposalDiffLine = { kind:'same'|'added'|'removed'; text:string };
export type ProposalFieldDiff = { field:string; before:string; after:string; command?:ProposalDiffLine[]; change?:'added'|'removed'|'changed' };
export type ProposalExecution = Pick<RunProposal,'name'|'command'|'shell'|'cwd'|'kind'|'env'|'previewUrl'>;

const value = (input:string|undefined) => input === undefined || input === '' ? '—' : visibleControlCharacters(input);
const commandLines = (text:string):string[] => text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
const commandLine = (text:string) => {
 const ending=text.endsWith('\r\n')?'CRLF':text.endsWith('\n')?'LF':text.endsWith('\r')?'CR':'no EOL';
 return `${visibleControlCharacters(text.replace(/(?:\r\n|\r|\n)$/, ''))} [${ending}]`;
};
/** Review strings are display-only: original bytes remain in the editor and in the save request. */
export function proposalReviewFields(proposal:ProposalExecution):{field:string;text:string}[] {
 return [
  {field:'Name',text:value(proposal.name)},
  {field:'Command',text:commandLines(proposal.command).map(commandLine).join('\n') || '[no EOL]'},
  {field:'Shell',text:proposal.shell==='powershell'?'Windows PowerShell':proposal.shell==='pwsh'?'PowerShell 7':proposal.shell==='cmd'?'CMD':value(proposal.shell)},
  {field:'Working directory',text:value(proposal.cwd)},
  {field:'Type',text:proposal.kind==='task'?'Task':proposal.kind==='service'?'Service':value(proposal.kind)},
  ...proposal.env.length ? proposal.env.map(item=>({field:`Environment: ${visibleControlCharacters(item.name)}`,text:item.value===''?'""':visibleControlCharacters(item.value)})) : [{field:'Environment',text:'—'}],
  {field:'Preview address',text:value(proposal.previewUrl)},
 ];
}
export function proposalFieldLabel(field:string, zh:boolean):string {
 if(!zh)return field;
 if(field.startsWith('Environment: '))return `环境变量：${field.slice('Environment: '.length)}`;
 return ({Name:'名称',Command:'命令',Shell:'命令行 Shell','Working directory':'工作目录',Type:'类型',Environment:'环境变量','Preview address':'预览地址'} as Record<string,string>)[field] ?? visibleControlCharacters(field);
}
/** Compare exact strings first, then escape their display. Environment changes are matched by Windows' case-insensitive name. */
export function proposalDiff(proposal:RunProposal):ProposalFieldDiff[] {
 if(!proposal.target)return [];
 const target=proposal.target;
 const fields:[string,string|undefined,string|undefined][]=[
  ['Name',target.name,proposal.name],['Command',target.command,proposal.command],['Working directory',target.cwd,proposal.cwd],
  ['Type',target.kind,proposal.kind],['Shell',target.shell,proposal.shell],
 ];
 const diff:ProposalFieldDiff[]=fields.filter(([,before,after])=>before!==after).map(([field,before,after])=>({field,before:value(before),after:value(after),...(field==='Command'?{command:lineDiff(before??'',after??'')}:{})}));
 const oldEnv=new Map(target.env.map(item=>[item.name.toUpperCase(),item])), newEnv=new Map(proposal.env.map(item=>[item.name.toUpperCase(),item]));
 for(const key of new Set([...oldEnv.keys(),...newEnv.keys()])) {
  const before=oldEnv.get(key),after=newEnv.get(key);
  if(before?.name===after?.name&&before?.value===after?.value)continue;
  diff.push({field:`Environment: ${visibleControlCharacters(after?.name??before!.name)}`,before:before?visibleControlCharacters(`${before.name}=${before.value}`):'—',after:after?visibleControlCharacters(`${after.name}=${after.value}`):'—',change:!before?'added':!after?'removed':'changed'});
 }
 if(target.previewUrl!==proposal.previewUrl)diff.push({field:'Preview address',before:value(target.previewUrl),after:value(proposal.previewUrl)});
 return diff;
}
/** Terminators participate in equality. CRLF/LF/CR and a missing final terminator stay visible. */
export function lineDiff(before:string, after:string):ProposalDiffLine[] {
 const left=commandLines(before),right=commandLines(after),rows:ProposalDiffLine[]=[];
 for(let index=0;index<Math.max(left.length,right.length);index++) {
  if(left[index]===right[index]) { if(left[index]!==undefined)rows.push({kind:'same',text:commandLine(left[index])}); }
  else { if(left[index]!==undefined)rows.push({kind:'removed',text:commandLine(left[index])}); if(right[index]!==undefined)rows.push({kind:'added',text:commandLine(right[index])}); }
 }
 return rows;
}

export function recentRunLabel(run:Pick<QuickLaunchRecentRun,'state'|'exitCode'|'stopped'|'endedAt'|'startedAt'>, zh:boolean, now=Date.now()):string {
 const states:Record<QuickLaunchRecentRun['state'],[string,string]>={starting:['Starting','启动中'],ready:['Ready','已就绪'],running:['Running','运行中'],completed:['Completed','已完成'],exited:['Exited','已退出'],failed:['Failed','失败'],stopped:['Stopped','已停止'],interrupted:['Interrupted','已中断']};
 const state=run.stopped ? (zh?'已停止':'Stopped') : `${states[run.state][zh?1:0]}${run.exitCode===undefined?'':zh?`（退出码 ${run.exitCode}）`:` (exit ${run.exitCode})`}`;
 const point=Date.parse(run.endedAt ?? run.startedAt), seconds=Math.max(0, Math.floor((now-point)/1000));
 const age=seconds<60 ? (zh ? '刚刚' : 'just now') : seconds<3600 ? (zh ? `${Math.floor(seconds/60)} 分钟前` : `${Math.floor(seconds/60)}m ago`) : seconds<86400 ? (zh ? `${Math.floor(seconds/3600)} 小时前` : `${Math.floor(seconds/3600)}h ago`) : (zh ? `${Math.floor(seconds/86400)} 天前` : `${Math.floor(seconds/86400)}d ago`);
 return `${state} · ${age}`;
}

type Scope={projectId:string;root:string};
function proposalEvents(scope:Scope, reload:()=>void) {
 return subscribeEvents(event => {
  if(event.event!=='state.changed') return;
  const data=event.data as {kind?:unknown;projectId?:unknown;worktreePath?:unknown;root?:unknown}|undefined;
  if(data?.kind !== 'quickLaunch.proposals' || (data.projectId !== undefined && data.projectId !== scope.projectId)) return;
  const root=String(data.worktreePath ?? data.root ?? '');
  if(!root || root===scope.root) reload();
 });
}
/** Runtime events are the cache invalidation signal. Every read is generation fenced; there is deliberately no poll. */
export function useRunProposals(scope:Scope, live:boolean, zh:boolean) {
 const [value,setValue]=useState<RunProposalList>({pending:[],decided:[]}),[loading,setLoading]=useState(false),[issue,setIssue]=useState<string>();
 const generation=useRef(0);
 const reload=useCallback(async()=>{const token=++generation.current;setLoading(true);try{const next=await request('quickLaunch.proposals.list',{projectId:scope.projectId,cwd:scope.root});if(token===generation.current)setValue(next);return next;}catch(error){if(token===generation.current)setIssue(quickLaunchError(error,zh));throw error;}finally{if(token===generation.current)setLoading(false);}},[scope.projectId,scope.root,zh]);
 useEffect(()=>{setValue({pending:[],decided:[]});setIssue(undefined);return()=>{generation.current++;};},[scope.projectId,scope.root]);
 useEffect(()=>{if(!live){generation.current++;return;}void reload().catch(()=>{});const unsubscribe=subscribeEvents(event=>{if(event.event!=='state.changed')return;const data=event.data as {kind?:unknown;projectId?:unknown;worktreePath?:unknown;root?:unknown}|undefined,kind=String(data?.kind??'');if((kind!=='quickLaunch.proposals'&&kind!=='quickLaunch.commands')||(data?.projectId!==undefined&&data.projectId!==scope.projectId))return;const root=String(data?.worktreePath??data?.root??'');if(!root||root===scope.root)void reload().catch(()=>{});});return()=>{generation.current++;unsubscribe();};},[live,reload,scope.projectId,scope.root]);
 return {...value,loading,issue,reload};
}
/** The badge remains live while the Run panel has never been visited or is hidden. */
export function useRunProposalCount(scope:Scope, zh:boolean):number {
 const [count,setCount]=useState(0),generation=useRef(0);
 const reload=useCallback(async()=>{const token=++generation.current;try{const rows=await request('quickLaunch.proposals.list',{projectId:scope.projectId,cwd:scope.root});if(token===generation.current)setCount(rows.pending.length);}catch{/* A badge failure must not make navigation fail. */}},[scope.projectId,scope.root]);
 useEffect(()=>{setCount(0);void reload();return()=>{generation.current++;};},[reload]);
 useEffect(()=>proposalEvents(scope,()=>void reload()),[reload,scope.projectId,scope.root]);
 return count;
}

export function useRecentRuns(scope:Scope, live:boolean, zh:boolean, sessionIds:ReadonlySet<string>, sessionKey:string) {
 const [value,setValue]=useState<QuickLaunchRecent>({runs:[]}),[loading,setLoading]=useState(false),[issue,setIssue]=useState<string>();
 const generation=useRef(0);
 const reload=useCallback(async()=>{const token=++generation.current;setLoading(true);try{const next=await request('quickLaunch.recent',{projectId:scope.projectId,cwd:scope.root});if(token===generation.current)setValue(next);return next;}catch(error){if(token===generation.current)setIssue(quickLaunchError(error,zh));throw error;}finally{if(token===generation.current)setLoading(false);}},[scope.projectId,scope.root,zh]);
 useEffect(()=>{setValue({runs:[]});setIssue(undefined);return()=>{generation.current++;};},[scope.projectId,scope.root]);
 const ids=useRef(sessionIds);ids.current=sessionIds;
 useEffect(()=>{if(!live){generation.current++;return;}void reload().catch(()=>{});const unsubscribe=subscribeEvents(event=>{const data=event.data as {kind?:unknown;projectId?:unknown;worktreePath?:unknown;root?:unknown;sessionId?:unknown}|undefined,kind=String(data?.kind??''),known=ids.current.has(String(data?.sessionId??''));const relevant=(event.event==='session.status'&&known)||(event.event==='state.changed'&&((kind==='quickLaunch.recent'&&(data?.projectId===undefined||data.projectId===scope.projectId))||kind==='session.run'||(kind==='session'&&known)));if(relevant){const root=String(data?.worktreePath??data?.root??'');if(!root||root===scope.root)void reload().catch(()=>{});}});return()=>{generation.current++;unsubscribe();};},[live,reload,scope.projectId,scope.root,sessionKey]);
 return {...value,loading,issue,reload};
}

export function proposalCommand(proposal:RunProposal):QuickLaunchCommand {
 return {id:proposal.targetCommandId ?? '',projectId:proposal.projectId,revision:proposal.target?.revision ?? 0,name:proposal.name,command:proposal.command,shell:proposal.shell,cwd:proposal.cwd,kind:proposal.kind,env:proposal.env,previewUrl:proposal.previewUrl,createdAt:proposal.createdAt,updatedAt:proposal.createdAt};
}
