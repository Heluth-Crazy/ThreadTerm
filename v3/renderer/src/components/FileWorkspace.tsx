import { Select } from "./ui/Select";
import { Icon } from "./PrototypeIcon";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Draft, FileDocument, FileEntry, GitDiff, GitStatus } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { CodeEditor } from './CodeEditor';
import { MergeEditor, type MergeEditorHandle } from './MergeEditor';
import { GitMergeControls } from './GitMergeControls';
import { SurfaceDialog } from './SurfaceDialog';
import { FilePreview } from './FilePreview';
import './file-workspace.css';
import { registerDirtyEditor } from '../dirtyEditors';

type View = 'file' | 'diff' | 'preview';
type Props = {projectId:string; worktreePath?:string; initialPath?:string; initialView?:View; view?:View; onViewChange?:(view:View)=>void; onDocumentChange?:(value:{path:string;dirty:boolean})=>void; editorId?:string; ownerSessionId?:string};
const message = (error:unknown) => error instanceof Error ? error.message : String(error);

export function FileWorkspace({projectId, worktreePath, initialPath, initialView='file',view:controlledView,onViewChange,onDocumentChange,editorId,ownerSessionId}:Props) {
  const scope = {projectId,worktreePath};
  const [tree,setTree] = useState<Record<string,FileEntry[]>>({});
  const [expanded,setExpanded] = useState(new Set(['']));
  const [treeQuery,setTreeQuery] = useState('');
  const [toolsOpen,setToolsOpen] = useState(false);
  const [openPaths,setOpenPaths] = useState<string[]>([]);
  const [document,setDocument] = useState<FileDocument>();
  const [text,setText] = useState('');
  const [internalView,setInternalView] = useState<View>(initialView);
  const previousControlledView=useRef<View|undefined>(controlledView);
  const view=internalView==='preview'?'preview':controlledView??internalView;
  const setView=(next:View)=>{setInternalView(next);if(next!=='preview')onViewChange?.(next);};
  const [staged,setStaged] = useState(false);
  const [diff,setDiff] = useState<GitDiff>();
  const mergeEditor=useRef<MergeEditorHandle>(null);
  const [git,setGit] = useState<GitStatus>();
  const [issue,setIssue] = useState<string>();
  const [busy,setBusy] = useState(false);
  const [commitMessage,setCommitMessage] = useState('');
  const [draftStatus,setDraftStatus] = useState<'saved'|'saving'|'unsaved'|'conflict'>('saved');
  const [pending,setPending] = useState<{path?:string;view:View;reload?:boolean;close?:'current'|'others'|'all'}>();
  const closeResolver=useRef<((value:boolean)=>void)|undefined>(undefined);
  const [closePrompt,setClosePrompt]=useState(false);
  const drafts = useRef(new Map<string,Draft>());
  const queue = useRef(Promise.resolve());
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const base = useRef('');
  const loaded = useRef<FileDocument | undefined>(undefined);
  const currentText = useRef(text); currentText.current=text;
  const mounted = useRef(true);
  const generation = useRef(0);
  const dirty = !!document && text!==document.content;
  const zh = globalThis.document.documentElement.lang==='zh-CN';
  const copy = zh ? {files:'文件',refresh:'刷新',changes:'改动',saved:'草稿已同步',saving:'正在同步草稿…',unsaved:'有未同步更改',conflict:'草稿冲突',save:'保存文件',edit:'编辑',preview:'预览',diff:'对比',staged:'已暂存',unstaged:'未暂存',empty:'选择文件开始编辑',readOnly:'只读',reload:'从磁盘重新载入',restore:'还原未暂存内容',cancel:'取消',discard:'放弃更改',question:'保存此文件的更改？',detail:'保存后继续；放弃会删除此文件的草稿。',retry:'重试同步',noGit:'此目录没有可用的 Git 状态。'} : {files:'Files',refresh:'Refresh',changes:'Changes',saved:'Draft synced',saving:'Syncing draft…',unsaved:'Unsynced changes',conflict:'Draft conflict',save:'Save file',edit:'Edit',preview:'Preview',diff:'Diff',staged:'Staged',unstaged:'Unstaged',empty:'Select a file to edit',readOnly:'Read only',reload:'Reload from disk',restore:'Restore unstaged content',cancel:'Cancel',discard:'Discard changes',question:'Save changes to this file?',detail:'Save before continuing, or discard this file’s draft.',retry:'Retry sync',noGit:'Git status is unavailable for this directory.'};

  async function refreshDirectory(path:string) {
    const entries=await request('filesystem.list',{...scope,path});
    if(mounted.current)setTree(current=>({...current,[path]:entries.sort((a,b)=>a.kind===b.kind?a.name.localeCompare(b.name):a.kind==='directory'?-1:1)}));
  }
  async function refreshGit() {
    try{const value=await request('git.status',scope);if(mounted.current)setGit(value);}catch{if(mounted.current)setGit(undefined);}
  }
  async function open(path:string,nextView:View='file',ignoreDraft=false) {
    const ticket=++generation.current;
    try {
      const value=await request('filesystem.read',{...scope,path});
      if(!mounted.current||ticket!==generation.current)return;
      const saved=ignoreDraft?undefined:drafts.current.get(path);
      loaded.current=value;base.current=saved?.baseFingerprint??value.fingerprint;
      setDocument(value);setText(saved?.content??value.content);setOpenPaths(paths=>paths.includes(path)?paths:[...paths,path]);setView(nextView);setDiff(undefined);setDraftStatus('saved');
      setIssue(saved&&saved.baseFingerprint!==value.fingerprint ? (zh?'磁盘文件已修改。草稿已保留，请对比后重新载入或合并。':'The disk file changed. Your draft is preserved; compare, then reload or merge before saving.') : undefined);
    }catch(error){if(mounted.current&&ticket===generation.current)setIssue(message(error));}
  }
  function persistDraft(doc:FileDocument,value:string,fingerprint:string) {
    if(mounted.current)setDraftStatus('saving');
    queue.current=queue.current.then(async()=>{
      const previous=drafts.current.get(doc.path);
      if(!previous&&value===doc.content){if(mounted.current)setDraftStatus('saved');return;}
      const saved=await request('draft.put',{...scope,path:doc.path,content:value,baseFingerprint:fingerprint,expectedRevision:previous?.revision??0,operationId:operationId()});
      drafts.current.set(doc.path,saved);
      if(mounted.current&&loaded.current?.path===doc.path)setDraftStatus(currentText.current===value?'saved':'unsaved');
    }).catch(error=>{if(mounted.current){setDraftStatus('conflict');setIssue(message(error));}});
    return queue.current;
  }
  useEffect(()=> {
    mounted.current=true;
    void refreshDirectory('').catch(error=>setIssue(message(error)));
    void refreshGit();
    void request('draft.list',scope).then(values=>{
      if(!mounted.current)return;
      drafts.current=new Map(values.map(draft=>[draft.path,draft]));
      if(initialPath)void open(initialPath,initialView);
    }).catch(error=>{if(mounted.current)setIssue(message(error));});
    return()=>{mounted.current=false;generation.current++;};
  },[projectId,worktreePath]);
  useEffect(()=>{const changed=controlledView!==previousControlledView.current;previousControlledView.current=controlledView;if(controlledView&&controlledView!==internalView&&(changed||internalView!=='preview'))setInternalView(controlledView);},[controlledView,internalView]);
  useEffect(()=>{if(!initialPath||initialPath===document?.path)return;if(dirty){setPending({path:initialPath,view});return;}void open(initialPath,view);},[initialPath]);
  useEffect(()=>{if(document)onDocumentChange?.({path:document.path,dirty});},[document?.path,dirty,onDocumentChange]);
  useEffect(()=>{
    if(!document||text===document.content&&!drafts.current.has(document.path))return;
    setDraftStatus('unsaved');
    const timer=setTimeout(()=>void persistDraft(document,text,base.current),500);debounce.current=timer;
    return()=>clearTimeout(timer);
  },[text,document]);
  useEffect(()=>()=>{
    const doc=loaded.current;
    if(doc&&currentText.current!==doc.content)void persistDraft(doc,currentText.current,base.current);
  },[projectId,worktreePath]);
  useEffect(()=>registerDirtyEditor(editorId??`${projectId}:${worktreePath??''}`,()=>{
    if(!loaded.current||currentText.current===loaded.current.content)return Promise.resolve(true);
    if(closeResolver.current)return Promise.resolve(false);
    return new Promise<boolean>(resolve=>{closeResolver.current=resolve;setClosePrompt(true);});
  },{projectId,worktreePath,ownerSessionId,isDirty:()=>Boolean(loaded.current&&currentText.current!==loaded.current.content)}),[editorId,projectId,worktreePath,ownerSessionId]);
  useEffect(()=>{
    if(view!=='diff'||!document)return;
    let alive=true;
    void request('git.diff',{...scope,path:document.path,staged}).then(value=>{if(alive)setDiff(value);}).catch(error=>{if(alive)setIssue(message(error));});
    return()=>{alive=false;};
  },[view,staged,document?.path,document?.fingerprint,projectId,worktreePath]);
  async function deleteDraft(path:string) {
    clearTimeout(debounce.current);
    await queue.current;
    const previous=drafts.current.get(path);
    if(previous){await request('draft.delete',{id:previous.id,expectedRevision:previous.revision,operationId:operationId()});drafts.current.delete(path);}
  }
  async function saveFile():Promise<boolean> {
    const doc=loaded.current;if(!doc||doc.readonly||busy)return false;
    const value=currentText.current;setBusy(true);setIssue(undefined);
    try{
      const saved=await request('filesystem.write',{...scope,path:doc.path,content:value,expectedFingerprint:base.current,operationId:operationId()});
      loaded.current=saved;base.current=saved.fingerprint;setDocument(saved);
      if(currentText.current===value){await deleteDraft(doc.path);setDraftStatus('saved');}
      else await persistDraft(saved,currentText.current,saved.fingerprint);
      void refreshGit();return true;
    }catch(error){setIssue(message(error));return false;}finally{setBusy(false);}
  }
  const choose=(path:string,nextView:View='file')=>{
    if(document?.path===path){setView(nextView);return;}
    if(dirty){setPending({path,view:nextView});return;}
    void open(path,nextView);
  };
  const closeOpenTabs=(kind:'current'|'others'|'all')=>{
    const active=document?.path;
    setOpenPaths(paths=>kind==='all'?[]:kind==='current'?paths.filter(path=>path!==active):paths.filter(path=>path===active));
    if(kind==='all'||kind==='current'){loaded.current=undefined;setDocument(undefined);setText('');onDocumentChange?.({path:'',dirty:false});}
  };
  const requestClose=(kind:'current'|'others'|'all')=>{if(!document||(kind==='others'&&openPaths.length<2))return;if(dirty){setPending({view,close:kind});return;}closeOpenTabs(kind);};
  async function continuePending(save:boolean) {
    if((!pending&&!closePrompt)||!document)return;
    if(save&&!await saveFile())return;
    try{if(!save)await deleteDraft(document.path);if(closePrompt){if(!save)currentText.current=document.content;setClosePrompt(false);closeResolver.current?.(true);closeResolver.current=undefined;return;}const next=pending!;setPending(undefined);if(next.close){closeOpenTabs(next.close);return;}if(next.path)await open(next.path,next.view,!!next.reload);}
    catch(error){setIssue(message(error));}
  }
  async function expand(path:string) {
    if(expanded.has(path)){setExpanded(current=>{const next=new Set(current);next.delete(path);return next;});return;}
    try{if(!tree[path])await refreshDirectory(path);setExpanded(current=>new Set([...current,path]));}catch(error){setIssue(message(error));}
  }
  async function changeIndex(unstage:boolean) {
    if(!document||dirty)return;setBusy(true);
    try{
      await request(unstage?'git.unstage':'git.stage',{...scope,paths:[document.path],expectedFingerprints:unstage?undefined:{[document.path]:document.fingerprint},operationId:operationId()});
      await refreshGit();setStaged(!unstage);
      setDiff(await request('git.diff',{...scope,path:document.path,staged:!unstage}));
    }catch(error){setIssue(message(error));}finally{setBusy(false);}
  }
  async function commit() {
    if(!commitMessage.trim())return;setBusy(true);
    try{await request('git.commit',{...scope,message:commitMessage.trim(),operationId:operationId()});setCommitMessage('');await refreshGit();setDiff(undefined);}
    catch(error){setIssue(message(error));}finally{setBusy(false);}
  }
  async function syncGit(method:'git.fetch'|'git.pull'|'git.push') {
    setBusy(true);setIssue(undefined);
    try{await request(method,{...scope,operationId:operationId()});await refreshGit();}
    catch(error){setIssue(message(error));}finally{setBusy(false);}
  }
  const renderTree=(path:string):ReactNode=>(tree[path]??[]).filter(entry=>!treeQuery||entry.kind==='directory'||entry.path.toLocaleLowerCase().includes(treeQuery.toLocaleLowerCase())).map(entry=>entry.kind==='directory'?<details key={entry.path} open={expanded.has(entry.path)}><summary onClick={event=>{event.preventDefault();void expand(entry.path);}}>{entry.name}</summary>{expanded.has(entry.path)&&renderTree(entry.path)}</details>:<button key={entry.path} className={document?.path===entry.path?'selected file-link':'file-link'} onClick={()=>choose(entry.path)} disabled={entry.kind==='symlink'}>{entry.name}</button>);

  return <section className={`file-workspace ${toolsOpen?'tools-open':''}`}>{toolsOpen&&<aside className="file-list tt-file-tree"><div className="file-list-heading"><strong>{copy.files}</strong><button className="icon-btn" aria-label={zh?'收起文件与 Git':'Hide files & Git'} onClick={()=>setToolsOpen(false)}>×</button><button className="btn" onClick={()=>void refreshDirectory('').catch(error=>setIssue(message(error)))}>{copy.refresh}</button></div><label className="file-tree-filter"><span className="sr-only">{copy.files}</span><input value={treeQuery} onChange={event=>setTreeQuery(event.target.value)} placeholder={zh?'筛选文件':'Filter files'} /></label><div className="file-tree-body">{renderTree('')}</div><section className="git-panel"><strong className="git-title">{copy.changes}</strong>{git?<><p className="git-summary">{git.branch??'HEAD'} <span>↑{git.ahead} ↓{git.behind}</span></p><div className="git-change-list">{git.changes.map(change=><button className="file-link" key={change.path} onClick={()=>choose(change.path,'diff')}><span>{change.indexStatus}{change.worktreeStatus}</span>{change.path}</button>)}</div><div className='git-sync'><button className="btn" disabled={busy} onClick={()=>void syncGit('git.fetch')}>{zh?'获取':'Fetch'}</button><button className="btn" disabled={busy||dirty} onClick={()=>void syncGit('git.pull')}>{zh?'拉取（快进）':'Pull (fast-forward)'}</button><button className="btn" disabled={busy} onClick={()=>void syncGit('git.push')}>{zh?'推送':'Push'}</button></div><GitMergeControls scope={scope} disabled={busy||dirty} onChanged={async()=>{await refreshGit();if(document&&!dirty)await open(document.path,view,true);}}/><label className='git-commit'><span>{zh?'提交说明':'Commit message'}</span><textarea value={commitMessage} onChange={event=>setCommitMessage(event.target.value)}/><button className="btn" disabled={busy||!commitMessage.trim()} onClick={()=>void commit()}>{zh?'提交已暂存内容':'Commit staged changes'}</button></label></>:<p>{copy.noGit}</p>}</section></aside>}<div className="editor-area">{document?<>{view!=='diff'&&<div className="tt-editor-tabs file-view-tabs">{openPaths.map(path=><button className={`tt-editor-tab ${path===document.path?'active':''}`} key={path} onClick={()=>choose(path,view)}>{path.split(/[\\/]/).at(-1)}{path===document.path&&dirty?' ·':''}</button>)}<span className="grow"/><button className="icon-btn file-tools-button" title={zh?'文件与 Git':'Files & Git'} aria-label={zh?'文件与 Git':'Files & Git'} aria-pressed={toolsOpen} onClick={()=>setToolsOpen(value=>!value)}><Icon name="panel"/></button>{draftStatus==='conflict'&&<button className="btn" onClick={()=>void persistDraft(document,text,base.current)}>{copy.retry}</button>}</div>}{view==='diff'?<section className="tt-diff-shell"><div className="file-bar"><button className="icon-btn file-tools-button" title={zh?'文件与 Git':'Files & Git'} aria-label={zh?'文件与 Git':'Files & Git'} aria-pressed={toolsOpen} onClick={()=>setToolsOpen(value=>!value)}><Icon name="panel"/></button><span className="path">{document.path}</span><span className="dim">{staged?copy.staged:copy.unstaged} · {staged||document.readonly?copy.readOnly:(zh?'左侧基线只读，右侧可编辑':'Baseline is read-only; current file is editable')}</span><span className="grow"/><button className="btn" disabled={busy||dirty} onClick={()=>void changeIndex(staged)}>{staged?(zh?'取消暂存':'Unstage'):(zh?'暂存文件':'Stage file')}</button>{!staged&&diff&&!diff.binary&&<><button className="btn" onClick={()=>mergeEditor.current?.revertLine()}>{zh?'还原当前行':'Revert current line'}</button><button className="btn" onClick={()=>mergeEditor.current?.revertHunk()}>{zh?'还原当前块':'Revert current hunk'}</button><button className="btn" disabled={busy||document.readonly||!dirty} onClick={()=>void saveFile()}>{zh?'保存变更':'Save changes'}</button><Select value={staged?'staged':'unstaged'} onChange={event=>setStaged(event.target.value==='staged')} aria-label={zh?'差异状态':'Diff state'}><option value="unstaged">{copy.unstaged}</option><option value="staged">{copy.staged}</option></Select></>}</div>{diff?.binary?<p className="tt-editor-state">{zh?'二进制文件无法显示文本对比。':'Binary files cannot be compared as text.'}</p>:diff?<MergeEditor ref={mergeEditor} path={document.path} oldText={diff.oldText} newText={staged?diff.newText:text} readOnly={staged||document.readonly} onChange={setText} onSave={()=>void saveFile()}/>:<p className="tt-editor-state">{zh?'正在读取对比…':'Loading diff…'}</p>}</section>:view==='preview'?<FilePreview {...scope} path={document.path} savedContent={document.content} content={text}/>:<><div className="file-bar"><span className="path" title={document.path}>{document.path}{dirty?' ·':''}</span><span className="dim">{copy[draftStatus]}{document.readonly?` · ${copy.readOnly}`:''}</span><span className="grow"/><button className="btn" onClick={()=>void saveFile()} disabled={busy||document.readonly||!dirty}>{copy.save}</button>{/\.(md|mdx|html?)$/i.test(document.path)&&<button className="btn" onClick={()=>setView('preview')}>{copy.preview}</button>}<button className="btn" onClick={()=>requestClose('current')}>{zh?'关闭当前':'Close current'}</button><button className="btn" disabled={openPaths.length<2} onClick={()=>requestClose('others')}>{zh?'关闭其他':'Close others'}</button><button className="icon-btn" onClick={()=>requestClose('all')} aria-label={zh?'关闭全部文件':'Close all files'}>×</button></div><section className="tt-editor-shell"><div className="tt-editor-meta"><span data-testid="editor-dirty" hidden={!dirty}>{zh?'未保存':'Unsaved'}</span><span>{document.path}</span></div><CodeEditor path={document.path} value={text} onChange={setText} onSave={()=>void saveFile()} readOnly={document.readonly}/></section></>}</>:<div className="empty tt-editor-state"><strong>{copy.empty}</strong><button className="btn" onClick={()=>setToolsOpen(true)}>{zh?'浏览文件':'Browse files'}</button></div>}{issue&&<div role="alert" className="tt-editor-conflict">{issue}{document&&<button onClick={()=>setPending({path:document.path,view,reload:true})}>{copy.reload}</button>}</div>}</div>{(pending||closePrompt)&&<SurfaceDialog title={copy.question} subtitle={document?.path} icon="file" size="sm" onClose={()=>{setPending(undefined);setClosePrompt(false);closeResolver.current?.(false);closeResolver.current=undefined}} footer={<><button className="btn" onClick={()=>{setPending(undefined);setClosePrompt(false);closeResolver.current?.(false);closeResolver.current=undefined}}>{copy.cancel}</button><button className="btn" onClick={()=>void continuePending(false)}>{copy.discard}</button><button className="btn btn-primary" disabled={busy} onClick={()=>void continuePending(true)}>{copy.save}</button></>}><p>{copy.detail}</p></SurfaceDialog>}</section>;
}
