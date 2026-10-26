import { useEffect, useMemo, useRef, useState } from 'react';
import { openExternalFiles, operationId, request, subscribeEvents } from '../bridge';
import { externalFileError as externalFilesError } from '../externalFiles';
import { Icon } from './PrototypeIcon';
import { fuzzyFilter, splitQuickOpenQuery } from '../workbench/fuzzy';
import { workbenchError } from '../workbench/errors';
import { scopeParams, type WorkbenchScope } from '../workbench/types';
import './command-palette.css';
import { useModalFocus } from '../useModalFocus';
import { useBrowserOcclusion } from '../browserOcclusion';

const cache = new Map<string,{at:number;paths:string[];truncated:boolean}>();
const CACHE_MS = 30_000;

function Highlighted({path, positions}:{path:string;positions:number[]}) {
 const nameStart = Math.max(path.lastIndexOf('/'),path.lastIndexOf('\\')) + 1, marks = new Set(positions);
 const render = (from:number, to:number) => Array.from(path.slice(from, to)).map((char, index) => marks.has(from + index) ? <mark key={from + index}>{char}</mark> : char);
 return <><b>{render(nameStart, path.length)}</b><span>{nameStart ? render(0, nameStart - 1) : ''}</span></>;
}

type ExternalFile = Awaited<ReturnType<typeof request<'filesystem.external.list'>>>['files'][number];
type OpenSource = 'dialog'|'recent';
type FilePosition = {line?:number;column?:number};
type QuickOpenItem = {kind:'dialog'} | {kind:'workspace';path:string;positions:number[]} | {kind:'external';file:ExternalFile;positions:number[]};

export function QuickOpen({scope, zh, onOpen, onClose, mode='open', onOpenExternal, externalDisabledReason}:{scope:WorkbenchScope;zh:boolean;onOpen:(path:string, position?:FilePosition)=>void;onClose:()=>void;mode?:'open'|'pick';onOpenExternal?:(paths:string[],source:OpenSource,position?:FilePosition)=>void|Promise<void>;externalDisabledReason?:string}) {
 const key = `${scope.projectId}\0${scope.worktreePath ?? ''}`;
 const [files, setFiles] = useState(() => cache.get(key));
 const [externalFiles, setExternalFiles] = useState<ExternalFile[]>();
 const [query, setQuery] = useState('');
 const [active, setActive] = useState(0);
 const [issue, setIssue] = useState<string>();
 const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
 const panel = useRef<HTMLElement>(null);
 const externalListGeneration = useRef(0);
 const zhRef = useRef(zh);
 zhRef.current = zh;
 const externalEnabled = mode === 'open' && !!onOpenExternal;
 useModalFocus(panel, onClose);
 useBrowserOcclusion();
 const text = (en:string, cn:string) => zh ? cn : en;
 useEffect(() => {
  input.current?.focus();
  const cached = cache.get(key);
  if(cached && Date.now() - cached.at < CACHE_MS) return;
  let live = true;
  void request('filesystem.files', scopeParams(scope)).then(value => {
   const entry = {at:Date.now(), ...value};
   cache.set(key, entry);
   if(live) setFiles(entry);
  }).catch(error => { if(live) setIssue(workbenchError(error, zh)); });
  return () => { live = false; };
 }, [key]);
 useEffect(() => {
  if(!externalEnabled) return;
  let live = true;
  const refresh = () => {
   const generation = ++externalListGeneration.current;
   void request('filesystem.external.list', {}).then(value => {
    if(live && generation === externalListGeneration.current) setExternalFiles(value.files);
   }).catch(error => { if(live && generation === externalListGeneration.current) setIssue(externalFilesError(error, zhRef.current)); });
  };
  refresh();
  const unsubscribe = subscribeEvents(event => {
   if(event.event === 'state.changed' && (event.data as {kind?:string}|undefined)?.kind === 'externalFiles') refresh();
  });
  return () => { live = false; unsubscribe(); };
 }, [externalEnabled]);
 const parsed = splitQuickOpenQuery(query);
 const matches = useMemo(() => files ? fuzzyFilter(files.paths, parsed.query, 60) : [], [files, parsed.query]);
 const externalMatches = useMemo(() => {
  if(!externalFiles) return [];
  const byPath = new Map(externalFiles.map(file => [file.path, file]));
  return (parsed.query?fuzzyFilter(externalFiles.map(file => file.path), parsed.query, 30):externalFiles.map(file=>({path:file.path,positions:[]}))).map(match => ({...match, file:byPath.get(match.path)!}));
 }, [externalFiles, parsed.query]);
 const items = useMemo<QuickOpenItem[]>(() => [
  ...(externalEnabled ? [{kind:'dialog' as const}] : []),
  ...matches.map(match => ({kind:'workspace' as const, ...match})),
  ...externalMatches.map(match => ({kind:'external' as const, file:match.file, positions:match.positions})),
 ], [externalEnabled, externalMatches, matches]);
 useEffect(()=>setActive(value=>Math.min(value,Math.max(0,items.length-1))),[items.length]);
 useEffect(() => setActive(0), [parsed.query]);
 useEffect(() => { list.current?.querySelector<HTMLElement>('.cmd-row.active')?.scrollIntoView({block:'nearest'}); }, [active]);
 const choose = (path:string) => { onClose(); onOpen(path, mode === 'open' && parsed.line ? {line:parsed.line, column:parsed.column} : undefined); };
 const chooseExternal = (paths:string[], source:OpenSource, position?:FilePosition) => {
  if(!onOpenExternal || externalDisabledReason) return;
  onClose();
  void Promise.resolve(onOpenExternal(paths, source, position)).catch(error => setIssue(externalFilesError(error, zh)));
 };
 const openDialog = () => {
  if(!onOpenExternal || externalDisabledReason) return;
  void openExternalFiles().then(paths => { if(paths.length) chooseExternal(paths, 'dialog'); }).catch(error => setIssue(externalFilesError(error, zh)));
 };
 const forgetExternal = (file:ExternalFile) => {
  ++externalListGeneration.current;
  setExternalFiles(files => files?.filter(value => value.id !== file.id));
  void request('filesystem.external.forget', {id:file.id, operationId:operationId()}).catch(error => {
   setIssue(externalFilesError(error, zh));
   const generation = ++externalListGeneration.current;
   void request('filesystem.external.list', {}).then(value => {
    if(generation === externalListGeneration.current) setExternalFiles(value.files);
   }).catch(() => undefined);
  });
 };
 const select = (item:QuickOpenItem) => {
  if(item.kind === 'dialog') openDialog();
  else if(item.kind === 'workspace') choose(item.path);
  else chooseExternal([item.file.path], 'recent', parsed.line ? {line:parsed.line, column:parsed.column} : undefined);
 };
 return <div className="scrim shell-palette-scrim" onMouseDown={event => { if(event.target === event.currentTarget) onClose(); }}>
  <section ref={panel} className="dialog palette wb-quick-open" role="dialog" aria-modal="true" aria-label={mode === 'pick' ? text('Add to Plans & docs', '添加到计划与文档') : text('Go to file', '转到文件')}>
   <input ref={input} className="palette-input" value={query} placeholder={mode === 'pick' ? text('Search files to add', '搜索要添加的文件') : text('Search files by name (append :line to jump)', '按文件名搜索（末尾加 :行号 可跳转）')}
    aria-label={text('File name', '文件名')} aria-controls="wb-quick-open-results" aria-activedescendant={items[active] ? `wb-qo-${active}` : undefined}
    onChange={event => setQuery(event.target.value)}
    onKeyDown={event => {
     if(event.key === 'Escape') { event.preventDefault(); onClose(); }
     else if(event.key === 'ArrowDown') { event.preventDefault(); setActive(value => Math.min(items.length - 1, value + 1)); }
     else if(event.key === 'ArrowUp') { event.preventDefault(); setActive(value => Math.max(0, value - 1)); }
     else if(event.key === 'Enter' && items[active]) { event.preventDefault(); select(items[active]); }
    }}/>
   <div className="palette-results" id="wb-quick-open-results" role="listbox" ref={list}>
    {issue && <p className="palette-empty" role="alert">{issue}</p>}
    {!files && !issue && <p className="palette-empty">{text('Indexing files…', '正在读取文件列表…')}</p>}
    {externalEnabled && <button type="button" role="option" aria-selected={active === 0} id="wb-qo-0" className={`cmd-row external-file-open${active === 0 ? ' active' : ''}`} disabled={!!externalDisabledReason} onMouseEnter={() => setActive(0)} onClick={openDialog} title={externalDisabledReason ?? text('Open file outside workspace (Ctrl+O)', '打开工作区外文件（Ctrl+O）')}>
     <Icon name="file"/><b>{text('Open file outside workspace…', '打开工作区外文件…')}</b><span>Ctrl+O</span>
    </button>}
    {matches.map((match, index) => { const itemIndex = (externalEnabled ? 1 : 0) + index; return <button type="button" role="option" aria-selected={itemIndex === active} id={`wb-qo-${itemIndex}`} key={match.path}
     className={`cmd-row${itemIndex === active ? ' active' : ''}`} onMouseEnter={() => setActive(itemIndex)} onClick={() => choose(match.path)} title={match.path}>
     <Icon name="file"/><Highlighted path={match.path} positions={match.positions}/>
    </button>; })}
    {externalEnabled && <><p className="external-file-section-label">{text('Outside workspace', '工作区外')}</p>{externalMatches.map((match, index) => { const itemIndex = 1 + matches.length + index; return <div role="option" aria-selected={itemIndex === active} id={`wb-qo-${itemIndex}`} key={match.file.id}
     className={`cmd-row external-file-recent${!match.file.exists ? ' external-file-missing' : ''}${itemIndex === active ? ' active' : ''}`} onMouseEnter={() => setActive(itemIndex)}>
     <button type="button" className="external-file-open-row" disabled={!!externalDisabledReason} onClick={() => chooseExternal([match.file.path], 'recent', parsed.line ? {line:parsed.line, column:parsed.column} : undefined)} title={externalDisabledReason ?? match.file.path}>
      <Icon name="file"/><Highlighted path={match.file.path} positions={match.positions}/>{!match.file.exists && <small>{text('Missing', '缺失')}</small>}
     </button><button type="button" className="icon-btn external-file-forget" aria-label={text('Remove from recent external files', '从最近工作区外文件中移除')} title={text('Remove from recent external files', '从最近工作区外文件中移除')} onClick={() => forgetExternal(match.file)}><Icon name="close"/></button>
    </div>; })}</>}
    {files && !matches.length && !externalMatches.length && <p className="palette-empty">{text('No matching files.', '没有匹配的文件。')}</p>}
   </div>
   <footer className="palette-foot">
    <span>{text('↑ ↓ Select', '↑ ↓ 选择')}</span><span>{mode === 'pick' ? text('Enter Add', 'Enter 添加') : text('Enter Open', 'Enter 打开')}</span><span>{text('Esc Close', 'Esc 关闭')}</span>
    {files?.truncated && <span className="wb-warn">{text(`First ${files.paths.length.toLocaleString()} files only`, `仅列出前 ${files.paths.length.toLocaleString()} 个文件`)}</span>}
   </footer>
  </section>
 </div>;
}

/** Drop cached listings after the host creates, renames or deletes files. */
export const invalidateQuickOpen = (scope:WorkbenchScope) => cache.delete(`${scope.projectId}\0${scope.worktreePath ?? ''}`);
