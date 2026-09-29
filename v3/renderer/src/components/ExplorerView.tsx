import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { FileEntry } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { Icon } from './PrototypeIcon';
import { CatalogPopover } from './CatalogActions';
import { SurfaceDialog } from './SurfaceDialog';
import { decorationIndex } from '../workbench/gitDecorations';
import { workbenchError } from '../workbench/errors';
import { createPortal } from 'react-dom';
import { WbIcon } from '../workbench/icons';
import { absolutePath, baseName, coveredBy, joinPath, parentPath, scopeParams, type GitState, type WorkbenchActions, type WorkbenchScope } from '../workbench/types';

type Editing = { mode:'rename'|'file'|'directory'; dir:string; target?:string; value:string; error?:string };
type Row = { entry:FileEntry; depth:number };
const sortEntries = (entries:FileEntry[]) => entries
 .filter(entry => entry.name !== '.git')
 .sort((left, right) => (left.kind === 'directory' ? 0 : 1) - (right.kind === 'directory' ? 0 : 1) || left.name.localeCompare(right.name, undefined, {numeric:true, sensitivity:'base'}));

export function ExplorerView({scope, actions, git, zh, activePath, focusKey, toolbarHost}:{scope:WorkbenchScope;actions:WorkbenchActions;git:GitState;zh:boolean;activePath?:string;focusKey?:string;toolbarHost?:HTMLElement|null}) {
 const [tree, setTree] = useState<Record<string,FileEntry[]>>({});
 const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
 const [selected, setSelected] = useState<string>();
 const [editing, setEditing] = useState<Editing>();
 const [menu, setMenu] = useState<{anchor:HTMLElement;entry?:FileEntry}>();
 const [confirm, setConfirm] = useState<{path:string;kind:FileEntry['kind'];permanent:boolean}>();
 const [issue, setIssue] = useState<string>();
 const [busy, setBusy] = useState(false);
 const treeRef = useRef<HTMLDivElement>(null);
 const expandedRef = useRef(expanded); expandedRef.current = expanded;
 const text = (en:string, cn:string) => zh ? cn : en;
 const params = scopeParams(scope);
 const decorations = useMemo(() => decorationIndex(git.status?.changes ?? []), [git.status]);

 const load = useCallback(async (dir:string) => {
  const entries = await request('filesystem.list', {...params, path:dir});
  setTree(current => ({...current, [dir]:sortEntries(entries)}));
 }, [scope.projectId, scope.worktreePath]);
 const refresh = useCallback(async () => {
  const dirs = [...expandedRef.current];
  const results = await Promise.allSettled(dirs.map(dir => request('filesystem.list', {...params, path:dir})));
  const next:Record<string,FileEntry[]> = {}, gone = new Set<string>();
  results.forEach((result, index) => { if(result.status === 'fulfilled') next[dirs[index]] = sortEntries(result.value); else gone.add(dirs[index]); });
  // Folders that disappeared collapse instead of showing stale children. Folders expanded while
  // this refresh was in flight (not in its snapshot) must stay open.
  setTree(current => ({...Object.fromEntries(Object.entries(current).filter(([dir]) => !gone.has(dir))), ...next}));
  setExpanded(current => new Set([...current].filter(dir => dir === '' || !gone.has(dir))));
 }, [scope.projectId, scope.worktreePath]);

 useEffect(() => { setTree({}); setExpanded(new Set([''])); void load('').catch(error => setIssue(workbenchError(error, zh))); }, [load]);
 // Git status refreshes (focus, polling, mutations) also refresh the visible folders.
 useEffect(() => { if(git.status) void refresh(); }, [git.status]);
 useEffect(() => { if(focusKey) treeRef.current?.querySelector<HTMLElement>('[data-path][tabindex="0"]')?.focus(); }, [focusKey]);

 // Reveal the active editor file by expanding its ancestors.
 useEffect(() => {
  if(!activePath) return;
  setSelected(activePath);
  const parts = activePath.split('/');
  const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
  const missing = ancestors.filter(dir => !expandedRef.current.has(dir));
  if(!missing.length) return;
  void Promise.all(missing.map(dir => load(dir).catch(() => undefined))).then(() => setExpanded(current => new Set([...current, ...ancestors])));
 }, [activePath, load]);

 const toggle = async (dir:string) => {
  if(expanded.has(dir)) { setExpanded(current => { const next = new Set(current); next.delete(dir); return next; }); return; }
  try { await load(dir); setExpanded(current => new Set([...current, dir])); }
  catch(error) { setIssue(workbenchError(error, zh)); }
 };
 const rows = useMemo(() => {
  const list:Row[] = [];
  const walk = (dir:string, depth:number) => { for(const entry of tree[dir] ?? []) { list.push({entry, depth}); if(entry.kind === 'directory' && expanded.has(entry.path)) walk(entry.path, depth + 1); } };
  walk('', 0);
  return list;
 }, [tree, expanded]);

 const guardDirty = (path:string, verb:string) => {
  const dirty = actions.dirtyPaths().filter(candidate => coveredBy(candidate, path));
  if(!dirty.length) return true;
  setIssue(text(`Save or discard unsaved changes in ${dirty.join(', ')} before you ${verb}.`, `请先保存或放弃 ${dirty.join('、')} 中未保存的更改，再${verb === 'rename' ? '重命名' : '删除'}。`));
  return false;
 };
 const beginCreate = (mode:'file'|'directory', entry?:FileEntry) => {
  const dir = !entry ? '' : entry.kind === 'directory' ? entry.path : parentPath(entry.path);
  setMenu(undefined); setIssue(undefined);
  if(dir && !expanded.has(dir)) void toggle(dir);
  setEditing({mode, dir, value:''});
 };
 const beginRename = (entry:FileEntry) => {
  setMenu(undefined); setIssue(undefined);
  if(!guardDirty(entry.path, 'rename')) return;
  setEditing({mode:'rename', dir:parentPath(entry.path), target:entry.path, value:entry.name});
 };
 const commitEditing = async () => {
  if(!editing || busy) return;
  const name = editing.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if(!name) { setEditing(undefined); return; }
  if(editing.mode === 'rename' && name === baseName(editing.target!)) { setEditing(undefined); return; }
  setBusy(true);
  try {
   if(editing.mode === 'rename') {
    const next = joinPath(editing.dir, name);
    await request('filesystem.rename', {...params, path:editing.target!, newPath:next, operationId:operationId()});
    actions.renamed(editing.target!, next);
    setSelected(next);
   } else {
    const created = await request('filesystem.create', {...params, path:joinPath(editing.dir, name), kind:editing.mode, operationId:operationId()});
    setSelected(created.path);
    // Nested names ("a/b/c.ts") create folders; expand the chain to show the result.
    const parts = created.path.split('/');
    const chain = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    await Promise.all(chain.map(dir => load(dir).catch(() => undefined)));
    setExpanded(current => new Set([...current, ...chain]));
    if(created.kind === 'file') actions.openFile(created.path);
   }
   setEditing(undefined);
   await refresh();
   void git.refresh();
  } catch(error) {
   setEditing(current => current && {...current, error:workbenchError(error, zh)});
  } finally { setBusy(false); }
 };
 const remove = async (permanent:boolean) => {
  if(!confirm) return;
  setBusy(true);
  try {
   await request('filesystem.delete', {...params, path:confirm.path, permanent, operationId:operationId()});
   actions.deleted(confirm.path);
   setConfirm(undefined);
   await refresh();
   void git.refresh();
  } catch(error) {
   if(!permanent && /recycle_unavailable|recycle_failed/.test(String(error))) setConfirm({...confirm, permanent:true});
   else { setIssue(workbenchError(error, zh)); setConfirm(undefined); }
  } finally { setBusy(false); }
 };
 const beginDelete = (entry:FileEntry) => {
  setMenu(undefined); setIssue(undefined);
  if(!guardDirty(entry.path, 'delete')) return;
  setConfirm({path:entry.path, kind:entry.kind, permanent:false});
 };
 const copy = (value:string) => { setMenu(undefined); void navigator.clipboard.writeText(value).catch(error => setIssue(workbenchError(error, zh))); };

 const onKey = (event:KeyboardEvent<HTMLDivElement>, row:Row, index:number) => {
  const focusRow = (next:number) => { const target = rows[Math.max(0, Math.min(rows.length - 1, next))]; if(target) { setSelected(target.entry.path); treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(target.entry.path)}"]`)?.focus(); } };
  const {entry} = row;
  if(event.key === 'ArrowDown') { event.preventDefault(); focusRow(index + 1); }
  else if(event.key === 'ArrowUp') { event.preventDefault(); focusRow(index - 1); }
  else if(event.key === 'ArrowRight' && entry.kind === 'directory' && !expanded.has(entry.path)) { event.preventDefault(); void toggle(entry.path); }
  else if(event.key === 'ArrowLeft') { event.preventDefault(); if(entry.kind === 'directory' && expanded.has(entry.path)) void toggle(entry.path); else { const parent = parentPath(entry.path); const at = rows.findIndex(candidate => candidate.entry.path === parent); if(at >= 0) focusRow(at); } }
  else if(event.key === 'Enter') { event.preventDefault(); if(entry.kind === 'directory') void toggle(entry.path); else actions.openFile(entry.path); }
  else if(event.key === 'F2') { event.preventDefault(); beginRename(entry); }
  else if(event.key === 'Delete') { event.preventDefault(); beginDelete(entry); }
  else if((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') { event.preventDefault(); setMenu({anchor:event.currentTarget, entry}); }
 };

 const editRow = (depth:number):ReactNode => editing && editing.mode !== 'rename' ? <div className="wb-tree-row editing" style={{paddingLeft:8 + depth * 14}}>
  <Icon name={editing.mode === 'directory' ? 'folder' : 'file'}/>
  <input autoFocus className="wb-inline-input" aria-label={editing.mode === 'directory' ? text('New folder name', '新文件夹名称') : text('New file name', '新文件名称')} value={editing.value} disabled={busy}
   onChange={event => setEditing({...editing, value:event.target.value, error:undefined})}
   onKeyDown={event => { if(event.key === 'Enter') { event.preventDefault(); void commitEditing(); } if(event.key === 'Escape') { event.preventDefault(); setEditing(undefined); } }}
   onBlur={() => { if(!busy && !editing.value.trim()) setEditing(undefined); }}/>
  {editing.error && <span className="wb-inline-error" role="alert">{editing.error}</span>}
 </div> : null;

 const focusable = selected && rows.some(row => row.entry.path === selected) ? selected : rows[0]?.entry.path;
 const tools = <>
   <button type="button" className="icon-btn" title={text('New file', '新建文件')} aria-label={text('New file', '新建文件')} onClick={() => beginCreate('file', rows.find(row => row.entry.path === selected)?.entry)}><WbIcon name="file-plus"/></button>
   <button type="button" className="icon-btn" title={text('New folder', '新建文件夹')} aria-label={text('New folder', '新建文件夹')} onClick={() => beginCreate('directory', rows.find(row => row.entry.path === selected)?.entry)}><WbIcon name="folder-plus"/></button>
   <button type="button" className="icon-btn" title={text('Refresh', '刷新')} aria-label={text('Refresh', '刷新')} onClick={() => { void refresh().catch(error => setIssue(workbenchError(error, zh))); void git.refresh(); }}><WbIcon name="refresh"/></button>
   <button type="button" className="icon-btn" title={text('Collapse all', '全部折叠')} aria-label={text('Collapse all', '全部折叠')} onClick={() => setExpanded(new Set(['']))}><WbIcon name="collapse-all"/></button>
 </>;
 return <div className="wb-explorer">
  {toolbarHost ? createPortal(tools, toolbarHost) : <div className="wb-view-actions">{tools}</div>}
  {issue && <p className="wb-issue" role="alert">{issue}<button type="button" className="icon-btn" aria-label={text('Dismiss', '关闭提示')} onClick={() => setIssue(undefined)}><Icon name="close"/></button></p>}
  <div className="wb-tree" role="tree" aria-label={text('Files', '文件')} ref={treeRef}>
   {editing && editing.dir === '' && editRow(0)}
   {rows.map((row, index) => {
    const {entry, depth} = row;
    const isDir = entry.kind === 'directory', open = isDir && expanded.has(entry.path);
    const decoration = isDir ? undefined : decorations.files.get(entry.path);
    const folderTone = isDir ? decorations.folders.get(entry.path) : undefined;
    const renaming = editing?.mode === 'rename' && editing.target === entry.path;
    return <div key={entry.path} className="wb-tree-item">
     {renaming ? <div className="wb-tree-row editing" style={{paddingLeft:8 + depth * 14}}>
      <Icon name={isDir ? 'folder' : 'file'}/>
      <input autoFocus className="wb-inline-input" aria-label={text('New name', '新名称')} value={editing.value} disabled={busy}
       onFocus={event => { const dot = event.currentTarget.value.lastIndexOf('.'); event.currentTarget.setSelectionRange(0, isDir || dot <= 0 ? event.currentTarget.value.length : dot); }}
       onChange={event => setEditing({...editing, value:event.target.value, error:undefined})}
       onKeyDown={event => { if(event.key === 'Enter') { event.preventDefault(); void commitEditing(); } if(event.key === 'Escape') { event.preventDefault(); setEditing(undefined); } }}
       onBlur={() => { if(!busy && !editing.error) setEditing(undefined); }}/>
      {editing.error && <span className="wb-inline-error" role="alert">{editing.error}</span>}
     </div> : <div role="treeitem" aria-level={depth + 1} aria-expanded={isDir ? open : undefined} aria-selected={selected === entry.path}
      tabIndex={entry.path === focusable ? 0 : -1} data-path={entry.path}
      className={`wb-tree-row${selected === entry.path ? ' selected' : ''}${decoration ? ` tone-${decoration.tone}` : folderTone ? ` tone-${folderTone} folder-tone` : ''}`}
      style={{paddingLeft:8 + depth * 14}} title={entry.path}
      onClick={() => { setSelected(entry.path); if(isDir) void toggle(entry.path); else actions.openFile(entry.path); }}
      onContextMenu={event => { event.preventDefault(); setSelected(entry.path); setMenu({anchor:event.currentTarget, entry}); }}
      onKeyDown={event => onKey(event, row, index)}>
      <span className={`wb-chevron${open ? ' open' : ''}`} aria-hidden="true">{isDir && <Icon name="chevR"/>}</span>
      <Icon name={isDir ? 'folder' : 'file'}/>
      <span className="wb-name">{entry.name}</span>
      {entry.kind === 'symlink' && <span className="wb-badge-muted" title={text('Link', '链接')}>↪</span>}
      {decoration && <span className="wb-deco" aria-label={decoration.tone}>{decoration.letter}</span>}
      {!decoration && folderTone && <span className="wb-deco-dot" aria-hidden="true"/>}
     </div>}
     {isDir && open && editing && editing.mode !== 'rename' && editing.dir === entry.path && editRow(depth + 1)}
    </div>;
   })}
   {!rows.length && !editing && <p className="wb-empty">{text('This folder is empty.', '此文件夹为空。')}</p>}
  </div>
  {menu && <CatalogPopover anchor={menu.anchor} label={menu.entry?.name ?? text('Files', '文件')} onClose={() => setMenu(undefined)}>
   {(() => {
    const entry = menu.entry, isFile = entry?.kind === 'file';
    const changed = entry && (git.status?.changes ?? []).some(change => change.path === entry.path);
    return <>
     <button type="button" role="menuitem" className="menu-item" onClick={() => beginCreate('file', entry)}><Icon name="file"/>{text('New file…', '新建文件…')}</button>
     <button type="button" role="menuitem" className="menu-item" onClick={() => beginCreate('directory', entry)}><Icon name="folder"/>{text('New folder…', '新建文件夹…')}</button>
     {entry && <>
      <div className="menu-sep"/>
      {isFile && actions.openBeside && <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(undefined); actions.openBeside?.(entry.path); }}><Icon name="split"/>{text('Open beside session', '在会话旁打开')}</button>}
      {isFile && changed && <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(undefined); actions.openDiff(entry.path, false); }}><Icon name="split"/>{text('Open changes', '查看更改')}</button>}
      {isFile && actions.openHistory && <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(undefined); actions.openHistory?.(entry.path); }}><Icon name="clock"/>{text('File history', '文件历史')}</button>}
      {isFile && actions.sendToAgent && <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(undefined); actions.sendToAgent?.({path:entry.path}); }}><Icon name="spark"/>{text('Send to agent', '发送给 Agent')}</button>}
      <button type="button" role="menuitem" className="menu-item" onClick={() => copy(absolutePath(scope.rootPath, entry.path))}><Icon name="export"/>{text('Copy path', '复制路径')}</button>
      <button type="button" role="menuitem" className="menu-item" onClick={() => copy(entry.path)}><Icon name="export"/>{text('Copy relative path', '复制相对路径')}</button>
      <div className="menu-sep"/>
      <button type="button" role="menuitem" className="menu-item" onClick={() => beginRename(entry)}><Icon name="file"/>{text('Rename…', '重命名…')}<kbd>F2</kbd></button>
      <button type="button" role="menuitem" className="menu-item danger" onClick={() => beginDelete(entry)}><Icon name="trash"/>{text('Delete…', '删除…')}<kbd>Del</kbd></button>
     </>}
    </>;
   })()}
  </CatalogPopover>}
  {confirm && <SurfaceDialog size="sm" icon="trash" title={confirm.permanent ? text('Delete permanently?', '永久删除？') : text('Move to Recycle Bin?', '移到回收站？')} subtitle={confirm.path}
   onClose={() => { if(!busy) setConfirm(undefined); }}
   footer={<>
    <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(undefined)}>{text('Cancel', '取消')}</button>
    <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove(confirm.permanent)}>{confirm.permanent ? text('Delete permanently', '永久删除') : text('Move to Recycle Bin', '移到回收站')}</button>
   </>}>
   <p>{confirm.permanent
    ? text('This drive has no Recycle Bin. The item will be deleted permanently and cannot be restored from ThreadTerm.', '此磁盘没有回收站，该项目将被永久删除，无法在 ThreadTerm 中恢复。')
    : confirm.kind === 'directory' ? text('The folder and everything inside it will be moved to the Recycle Bin.', '该文件夹及其全部内容将移到回收站。') : text('You can restore it from the Recycle Bin.', '可以从回收站恢复。')}</p>
  </SurfaceDialog>}
 </div>;
}
