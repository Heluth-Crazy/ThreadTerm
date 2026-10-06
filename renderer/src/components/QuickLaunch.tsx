import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { QuickLaunchCommand, QuickLaunchEnvVar, QuickLaunchKind, QuickLaunchShell, Session, Snapshot } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { useTranslation } from '../i18n';
import { displayPath, pathIsWithinCanonicalScope, sameCanonicalScope } from '../projectScope';
import { isWebTabUrl } from '../workspaceTabs';
import { activeRun, packageScripts, quickLaunchError, runState, runStateLabel, type PackageScript } from '../quickLaunch';
import { Icon } from './PrototypeIcon';
import { SurfaceDialog } from './SurfaceDialog';
import { Select } from './ui/Select';
import './shell-menus.css';
import './quick-launch.css';

const Play = () => <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>;
type Props = { projectId: string; root: string; data: Snapshot; onOpenSession: (id: string) => void; onOpenPreview?: (url: string) => void };
export function QuickLaunchMenu({ projectId, root, data, onOpenSession, onOpenPreview }: Props) {
 const { locale } = useTranslation(), zh = locale === 'zh-CN', copy = (en:string,cn:string) => zh ? cn : en;
 const [open,setOpen] = useState(false), [editor,setEditor] = useState<QuickLaunchCommand|'new'>(), [importing,setImporting] = useState(false);
 const [commands,setCommands] = useState<QuickLaunchCommand[]>([]), [loading,setLoading] = useState(false), [issue,setIssue] = useState<string>(), [busy,setBusy] = useState(false);
 const anchor = useRef<HTMLButtonElement>(null), generation = useRef(0), action = useRef(false), id = useId();
 useEffect(() => () => { generation.current++; }, [projectId,root]);
 const refresh = async () => {
  const token = ++generation.current; setLoading(true); setIssue(undefined);
  try { const rows = await request('quickLaunch.list',{projectId}); if(token === generation.current)setCommands(rows); return rows; }
  catch(error) { if(token === generation.current)setIssue(quickLaunchError(error,zh)); throw error; }
  finally { if(token === generation.current)setLoading(false); }
 };
 const run = async (command:QuickLaunchCommand) => { const result = await request('quickLaunch.run',{commandId:command.id,cwd:root,operationId:operationId()}); setOpen(false); onOpenSession(result.session.id); };
 const perform = async (task:()=>Promise<void>) => { if(action.current)return; action.current=true;setBusy(true);setIssue(undefined);try{await task();}catch(error){setIssue(quickLaunchError(error,zh));}finally{action.current=false;setBusy(false);} };
 const edit = (command:QuickLaunchCommand|'new') => { setOpen(false);setEditor(command);void refresh().catch(()=>{}); };
 const startImport = () => { setOpen(false);setImporting(true); };
 const runs = new Map<string,Session[]>();
 if(open){const projectRoot=data.projects.find(project=>project.id===projectId)?.path;for(const session of data.sessions){if(session.projectId!==projectId||!session.run||!sameCanonicalScope(session.worktreePath??projectRoot,root))continue;const scoped=session.worktreePath?session:{...session,worktreePath:projectRoot};const group=runs.get(session.run.commandId)??[];group.push(scoped);runs.set(session.run.commandId,group);}}
 return <>
  <button ref={anchor} type="button" className="btn ql-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>{if(open)setOpen(false);else{setOpen(true);void refresh().catch(()=>{});}}} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();if(!open){setOpen(true);void refresh().catch(()=>{});}}}}><Play/>{copy('Run','运行')}<Icon name="chevD"/></button>
  {open&&<LaunchPopover id={id} anchor={anchor.current} onClose={()=>setOpen(false)} title={copy('Run commands','运行命令')}>
   {issue&&<p className="surface-error" role="alert">{issue}<button className="btn" disabled={loading||busy} onClick={()=>void refresh().catch(()=>{})}>{copy('Reload','重新加载')}</button></p>}
   {loading?<p className="shell-menu-empty" role="status">{copy('Loading commands…','正在加载命令…')}</p>:<div className="ql-list">{commands.map(command=>{
    const scoped = runs.get(command.id)??[];
    const active = activeRun(scoped,command.id,root), latest = active ?? scoped.filter(session=>session.run?.commandId===command.id&&sameCanonicalScope(session.worktreePath,root)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.updatedAt.localeCompare(a.updatedAt))[0];
    const view = latest ? runState(latest) : undefined;
    return <section className="ql-command" key={command.id} data-testid={`quick-launch-command-${command.id}`} aria-label={command.name}>
     <div className="ql-command-head"><strong>{command.name}</strong>{view&&<span className={`ql-state ql-${view.state}`}><span className="dot" aria-hidden="true"/>{runStateLabel(view,zh)}</span>}</div><code title={command.command}>{command.command}</code>
     <div className="ql-actions"><button className="btn" disabled={busy} onClick={()=>active?(setOpen(false),onOpenSession(active.id)):void perform(()=>run(command))}>{active?<Icon name="terminal"/>:<Play/>}{active?copy('Open terminal','打开终端'):copy('Run','运行')}</button>{active&&<button className="btn" disabled={busy} onClick={()=>void perform(async()=>{await request('session.stop',{sessionId:active.id,operationId:operationId()});})}>{copy('Stop','停止')}</button>}{view?.url&&onOpenPreview&&<button className="btn" disabled={busy} onClick={()=>{setOpen(false);onOpenPreview(view.url!);}}>{copy('Preview','预览')}</button>}<button className="btn btn-ghost" disabled={busy} onClick={()=>edit(command)}>{copy('Edit','编辑')}</button></div>
    </section>;
   })}{!commands.length&&<div className="shell-menu-empty"><p>{copy('No saved commands','没有保存的命令')}</p><button className="btn" onClick={startImport}>{copy('Import from package.json','从 package.json 导入')}</button></div>}</div>}
   <footer className="shell-menu-foot"><button className="menu-item" disabled={busy} onClick={()=>edit('new')}><Icon name="plus"/>{copy('New command','新建命令')}</button><button className="menu-item" disabled={busy} onClick={startImport}>{copy('Import scripts','导入脚本')}</button></footer>
  </LaunchPopover>}
  {editor&&<CommandEditor key={editor==='new'?'new':editor.id} command={editor==='new'?undefined:editor} projectId={projectId} root={root} onClose={()=>{setEditor(undefined);anchor.current?.focus();}} onChanged={async()=>{await refresh();}} onReload={async commandId=>(await refresh()).find(command=>command.id===commandId)} onRun={run}/>}
  {importing&&<ImportScripts projectId={projectId} root={root} onClose={()=>{setImporting(false);anchor.current?.focus();}} onChanged={async()=>{await refresh();}}/>}
 </>;
}

/** ShellMenus' dismiss/restore pattern; mounted only while open, with native button arrow navigation. */
function LaunchPopover({id,anchor,onClose,title,children}:{id:string;anchor:HTMLElement|null;onClose:()=>void;title:string;children:React.ReactNode}) {
 const panel = useRef<HTMLElement>(null), close = useRef(onClose);close.current=onClose;
 useEffect(()=>{
  panel.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  const pointer=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!anchor?.contains(event.target as Node))close.current();};
  const key=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close.current();}};
  addEventListener('pointerdown',pointer);addEventListener('keydown',key);
  return()=>{removeEventListener('pointerdown',pointer);removeEventListener('keydown',key);if(anchor?.isConnected)anchor.focus();};
 },[anchor]);
 const navigate=(event:KeyboardEvent)=>{
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  const buttons=Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]), index=buttons.indexOf(document.activeElement as HTMLButtonElement);
  if(!buttons.length)return;event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();
 };
 const box=anchor?.getBoundingClientRect(), width=Math.min(480,innerWidth-16);
 return createPortal(<aside ref={panel} id={id} role="dialog" aria-label={title} data-testid="quick-launch-menu" className="popover shell-menu ql-menu" onKeyDown={navigate} style={{left:Math.max(8,Math.min(innerWidth-width-8,box?.left??8)),top:Math.min(box?.bottom??8,innerHeight-80)+6,maxHeight:Math.max(64,innerHeight-(box?.bottom??8)-14)}}><header className="shell-menu-head"><strong>{title}</strong><button className="icon-btn" aria-label={title.startsWith('运行')?'关闭运行菜单':'Close run menu'} onClick={onClose}><Icon name="close"/></button></header>{children}</aside>,document.body);
}

type Draft = { name:string; shell:QuickLaunchShell; command:string; cwd:string; kind:QuickLaunchKind; env:QuickLaunchEnvVar[]; previewUrl:string };
const draftFor=(command?:QuickLaunchCommand):Draft=>({name:command?.name??'',shell:command?.shell??'cmd',command:command?.command??'',cwd:command?.cwd??'',kind:command?.kind??'service',env:command?.env.map(row=>({...row}))??[],previewUrl:command?.previewUrl??''});
function CommandEditor({command,projectId,root,onClose,onChanged,onReload,onRun}:{command?:QuickLaunchCommand;projectId:string;root:string;onClose:()=>void;onChanged:()=>Promise<void>;onReload:(id:string)=>Promise<QuickLaunchCommand|undefined>;onRun:(command:QuickLaunchCommand)=>Promise<void>}) {
 const {locale}=useTranslation(),zh=locale==='zh-CN',copy=(en:string,cn:string)=>zh?cn:en,id=useId();
 const [saved,setSaved]=useState(command),[draft,setDraft]=useState(()=>draftFor(command)),[busy,setBusy]=useState(false),[issue,setIssue]=useState<string>(),[conflict,setConflict]=useState(false),[deleting,setDeleting]=useState(false);
 const lock=useRef(false),formId=`ql-editor-${id}`,saveAttempt=useRef<{key:string;operationId:string}|undefined>(undefined),deleteAttempt=useRef<{revision:number;operationId:string}|undefined>(undefined);
 const update=<K extends keyof Draft>(key:K,value:Draft[K])=>setDraft(current=>({...current,[key]:value}));
 const close=()=>{if(!lock.current)onClose();};
 const save=async(launch:boolean)=>{
  if(lock.current)return;lock.current=true;setBusy(true);setIssue(undefined);
  try {
   if(draft.shell==='cmd'&&/[\r\n]/.test(draft.command))throw new Error('cmd_single_line');
   const names=draft.env.map(row=>row.name.trim().toUpperCase());
   if(names.some(name=>!name||!/^[A-Z_][A-Z0-9_]*$/.test(name))||new Set(names).size!==names.length)throw new Error('invalid_env');
   if(draft.previewUrl.trim()&&!isWebTabUrl(draft.previewUrl.trim()))throw new Error('invalid_preview_url');
   const params={projectId,id:saved?.id,expectedRevision:saved?.revision,...draft,name:draft.name.trim(),env:draft.env.map(row=>({name:row.name.trim(),value:row.value})),previewUrl:draft.previewUrl.trim()||undefined},key=JSON.stringify(params);
   if(saveAttempt.current?.key!==key)saveAttempt.current={key,operationId:operationId()};
   const result=await request('quickLaunch.save',{...params,operationId:saveAttempt.current.operationId});saveAttempt.current=undefined;
   setSaved(result);setConflict(false);await onChanged();if(launch)await onRun(result);onClose();
  } catch(error){setIssue(quickLaunchError(error,zh));setConflict(String(error).includes('revision_conflict'));}
  finally{lock.current=false;setBusy(false);}
 };
 const reload=async()=>{if(!saved||lock.current)return;lock.current=true;setBusy(true);try{const latest=await onReload(saved.id);if(!latest)throw new Error('command_not_found');setSaved(latest);setDraft(draftFor(latest));setConflict(false);setIssue(undefined);}catch(error){setIssue(quickLaunchError(error,zh));}finally{lock.current=false;setBusy(false);}};
 const remove=async()=>{if(!saved||lock.current)return;lock.current=true;setBusy(true);try{if(deleteAttempt.current?.revision!==saved.revision)deleteAttempt.current={revision:saved.revision,operationId:operationId()};await request('quickLaunch.delete',{id:saved.id,expectedRevision:saved.revision,operationId:deleteAttempt.current.operationId});await onChanged();onClose();}catch(error){setDeleting(false);setIssue(quickLaunchError(error,zh));setConflict(String(error).includes('revision_conflict'));}finally{lock.current=false;setBusy(false);}};
 const valid=Boolean(draft.name.trim()&&draft.command.trim())&&!conflict;
 return <><SurfaceDialog title={saved?copy('Edit command','编辑命令'):copy('New command','新建命令')} subtitle={displayPath(root)} icon="terminal" variant="plain" className="ql-editor" onClose={close} footer={<>{saved&&<button className="btn danger ql-delete" disabled={busy} onClick={()=>setDeleting(true)}>{copy('Delete','删除')}</button>}<button className="btn" disabled={busy} onClick={close}>{copy('Cancel','取消')}</button><button className="btn" disabled={busy||!valid} onClick={()=>void save(true)}>{copy('Save and run','保存并运行')}</button><button className="btn btn-primary" type="submit" form={formId} disabled={busy||!valid}>{busy?copy('Saving…','正在保存…'):copy('Save','保存')}</button></>}>
  <form id={formId} onSubmit={event=>{event.preventDefault();void save(false);}}><fieldset disabled={busy} className="ql-fields">
   <div className="field"><label htmlFor={`${id}-name`}>{copy('Name','名称')}</label><input id={`${id}-name`} required maxLength={80} value={draft.name} onChange={e=>update('name',e.target.value)}/></div>
   <div className="field"><label id={`${id}-shell-label`}>{copy('Shell','命令行 Shell')}</label><Select aria-labelledby={`${id}-shell-label`} aria-label={copy('Shell','命令行 Shell')} value={draft.shell} onChange={e=>update('shell',e.target.value as QuickLaunchShell)}><option value="cmd">CMD</option><option value="powershell">Windows PowerShell</option><option value="pwsh">PowerShell 7</option></Select></div>
   <div className="field"><label htmlFor={`${id}-command`}>{copy('Command','命令')}</label>{draft.shell==='cmd'?<input id={`${id}-command`} required maxLength={8000} value={draft.command} onChange={e=>update('command',e.target.value)}/>:<textarea id={`${id}-command`} required maxLength={8000} rows={4} value={draft.command} onChange={e=>update('command',e.target.value)}/>}<p className="note">{draft.shell==='cmd'?copy('CMD runs one line — join with &&','CMD 仅执行一行，请用 && 连接'):copy('PowerShell supports multiple lines.','PowerShell 支持多行命令。')}</p>{draft.shell==='cmd'&&/[\r\n]/.test(draft.command)&&<p className="surface-error">{quickLaunchError('cmd_single_line',zh)}</p>}</div>
   <div className="field"><label htmlFor={`${id}-cwd`}>{copy('Working directory','工作目录')}</label><input id={`${id}-cwd`} maxLength={260} value={draft.cwd} onChange={e=>update('cwd',e.target.value)} placeholder={copy('worktree root','工作树根目录')}/><p className="note">{copy('Relative to the selected worktree root.','相对于所选工作树的根目录。')}</p></div>
   <div className="field"><label id={`${id}-kind-label`}>{copy('Type','类型')}</label><Select aria-labelledby={`${id}-kind-label`} aria-label={copy('Type','类型')} value={draft.kind} onChange={e=>update('kind',e.target.value as QuickLaunchKind)}><option value="service">{copy('Service','服务')}</option><option value="task">{copy('Task','任务')}</option></Select></div>
   <details className="ql-advanced"><summary>{copy('Advanced','高级')}</summary><p className="note">{copy('Inherits the current environment. %PATH% expands in values, for example C:\\jdk\\bin;%PATH%.','继承当前环境。值中的 %PATH% 会展开，例如 C:\\jdk\\bin;%PATH%。')}</p><div className="field"><label>{copy('Environment overrides','环境变量覆盖')}</label>{draft.env.map((row,index)=><div className="ql-env-row" key={index}><input aria-label={`${copy('Environment name','环境变量名')} ${index+1}`} placeholder={copy('NAME','变量名')} maxLength={128} value={row.name} onChange={e=>update('env',draft.env.map((current,i)=>i===index?{...current,name:e.target.value}:current))}/><input aria-label={`${copy('Environment value','环境变量值')} ${index+1}`} placeholder={copy('value','值')} maxLength={8192} value={row.value} onChange={e=>update('env',draft.env.map((current,i)=>i===index?{...current,value:e.target.value}:current))}/><button type="button" className="icon-btn" aria-label={`${copy('Remove variable','移除变量')} ${index+1}`} onClick={()=>update('env',draft.env.filter((_,i)=>i!==index))}><Icon name="close"/></button></div>)}<button type="button" className="btn" disabled={draft.env.length>=32} onClick={()=>update('env',[...draft.env,{name:'',value:''}])}>{copy('Add variable','添加变量')}</button></div><div className="field"><label htmlFor={`${id}-preview`}>{copy('Preview address','预览地址')}</label><input id={`${id}-preview`} maxLength={2048} value={draft.previewUrl} onChange={e=>update('previewUrl',e.target.value)} placeholder="http://localhost:5173/"/><p className="note">{copy('Fallback only. A local address printed by this run takes precedence.','仅作为备用地址。优先使用此运行输出的本地地址。')}</p></div></details>
  </fieldset>{issue&&<p className="surface-error" role="alert">{issue}</p>}{conflict&&<button type="button" className="btn" disabled={busy} onClick={()=>void reload()}>{copy('Reload command (replaces draft)','重新加载命令（替换草稿）')}</button>}</form>
 </SurfaceDialog>{deleting&&<SurfaceDialog title={copy('Delete command','删除命令')} size="sm" variant="plain" onClose={()=>{if(!busy)setDeleting(false);}} footer={<><button className="btn" disabled={busy} onClick={()=>setDeleting(false)}>{copy('Cancel','取消')}</button><button className="btn danger" disabled={busy} onClick={()=>void remove()}>{copy('Delete command','删除命令')}</button></>}><p>{copy('Delete this saved command? Running runs keep running.','删除此保存的命令？正在运行的任务会继续运行。')}</p></SurfaceDialog>}</>;
}

function relativeDirectory(root:string,input:string):string {
 const base=displayPath(root).replace(/\\/g,'/').replace(/\/+$/,''), value=displayPath(input).replace(/\\/g,'/').replace(/\/+$/,'');
 const absolute=/^(?:[A-Za-z]:|\/)/.test(value);
 if(absolute&&!pathIsWithinCanonicalScope(value,base))throw new Error('cwd_outside_root');
 const relative=absolute?value.slice(base.length).replace(/^\/+/, ''):value;
 if(relative.split('/').includes('..'))throw new Error('cwd_outside_root');
 return relative.split('/').filter(part=>part&&part!=='.').join('/');
}
function ImportScripts({projectId,root,onClose,onChanged}:{projectId:string;root:string;onClose:()=>void;onChanged:()=>Promise<void>}) {
 const {locale}=useTranslation(),zh=locale==='zh-CN',copy=(en:string,cn:string)=>zh?cn:en,id=useId();
 const [directory,setDirectory]=useState(displayPath(root)),[loaded,setLoaded]=useState<{cwd:string;scripts:PackageScript[]}>(),[selected,setSelected]=useState<Set<string>>(new Set()),[busy,setBusy]=useState(false),[issue,setIssue]=useState<string>();
 const lock=useRef(false), imported=useRef(new Set<string>()),attempts=useRef(new Map<string,string>());
 const close=()=>{if(!lock.current)onClose();};
 const load=async()=>{
  if(lock.current)return;lock.current=true;setBusy(true);setIssue(undefined);setLoaded(undefined);imported.current.clear();attempts.current.clear();
  try{const cwd=relativeDirectory(root,directory), scope={projectId,worktreePath:root};
   const results=await Promise.allSettled([request('filesystem.read',{...scope,path:cwd?`${cwd}/package.json`:'package.json'}),request('filesystem.list',{...scope,path:cwd||'.'})]);
   if(results[0].status==='rejected')throw /file_not_found|not_found|No such file/.test(String(results[0].reason))?new Error('no_package_json'):results[0].reason;
   if(results[1].status==='rejected')throw results[1].reason;
   const scripts=packageScripts(results[0].value.content,results[1].value.filter(entry=>entry.kind==='file').map(entry=>entry.name));
   if(!scripts.length)throw new Error('no_package_scripts');setLoaded({cwd,scripts});setSelected(new Set(scripts.filter(script=>['dev','start','build','test'].includes(script.name)).map(script=>script.name)));
  }catch(error){setIssue(quickLaunchError(error,zh));}finally{lock.current=false;setBusy(false);}
 };
 useEffect(()=>{void load();},[]);
 const save=async()=>{
  if(!loaded||lock.current)return;lock.current=true;setBusy(true);setIssue(undefined);
  try{for(const script of loaded.scripts.filter(script=>selected.has(script.name)&&!imported.current.has(script.name))){const attempt=attempts.current.get(script.name)??operationId();attempts.current.set(script.name,attempt);await request('quickLaunch.save',{projectId,...script,shell:'cmd',cwd:loaded.cwd,env:[],operationId:attempt});imported.current.add(script.name);}await onChanged();onClose();}
  catch(error){setIssue(quickLaunchError(error,zh));await onChanged().catch(()=>{});}
  finally{lock.current=false;setBusy(false);}
 };
 return <SurfaceDialog title={copy('Import scripts','导入脚本')} subtitle={copy('Create saved commands from package.json.','从 package.json 创建保存的命令。')} icon="file" variant="plain" className="ql-import" onClose={close} footer={<><span className="sheet-foot-meta">{selected.size} {copy('selected','项已选择')}</span><button className="btn" disabled={busy} onClick={close}>{copy('Cancel','取消')}</button><button className="btn btn-primary" disabled={busy||!loaded||!selected.size} onClick={()=>void save()}>{copy('Import selected','导入所选')}</button></>}>
  <form onSubmit={event=>{event.preventDefault();void load();}}><div className="field"><label htmlFor={`${id}-directory`}>{copy('Directory','目录')}</label><div className="ql-directory"><input id={`${id}-directory`} disabled={busy} value={directory} onChange={event=>{setDirectory(event.target.value);setLoaded(undefined);setSelected(new Set());}}/><button type="submit" className="btn" disabled={busy}>{copy('Load scripts','加载脚本')}</button></div><p className="note">{copy('A directory inside the selected worktree.','所选工作树内的目录。')}</p></div></form>
  {busy&&<p role="status" className="note">{copy('Working…','正在处理…')}</p>}{issue&&<p className="surface-error" role="alert">{issue}</p>}
  <div className="ql-script-list">{loaded?.scripts.map(script=><label className="ql-script" key={script.name}><input type="checkbox" disabled={busy||imported.current.has(script.name)} checked={selected.has(script.name)} onChange={event=>setSelected(current=>{const next=new Set(current);event.target.checked?next.add(script.name):next.delete(script.name);return next;})}/><span><strong>{script.name}</strong><code>{script.command}</code></span><span className="dim">{script.kind==='service'?copy('Service','服务'):copy('Task','任务')}{imported.current.has(script.name)?copy(' · Saved',' · 已保存'):''}</span></label>)}</div>
 </SurfaceDialog>;
}

export function QuickLaunchRunChip({session,onOpenPreview}:{session:Session;onOpenPreview?:(url:string)=>void}) {
 const {locale}=useTranslation(),zh=locale==='zh-CN';if(!session.run)return null;const view=runState(session);
 return <><span className={`ql-run-chip ql-state ql-${view.state}`} data-testid="quick-launch-run-chip" title={session.run.name}><span className="dot" aria-hidden="true"/><span>{session.run.name} · {runStateLabel(view,zh)}</span></span>{view.url&&onOpenPreview&&<button type="button" className="btn" onClick={()=>onOpenPreview(view.url!)}>{zh?'预览':'Preview'}</button>}</>;
}
