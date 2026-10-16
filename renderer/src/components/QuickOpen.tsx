import { useEffect, useMemo, useRef, useState } from 'react';
import { request } from '../bridge';
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
 const nameStart = path.lastIndexOf('/') + 1, marks = new Set(positions);
 const render = (from:number, to:number) => Array.from(path.slice(from, to)).map((char, index) => marks.has(from + index) ? <mark key={from + index}>{char}</mark> : char);
 return <><b>{render(nameStart, path.length)}</b><span>{nameStart ? render(0, nameStart - 1) : ''}</span></>;
}

export function QuickOpen({scope, zh, onOpen, onClose, mode='open'}:{scope:WorkbenchScope;zh:boolean;onOpen:(path:string, position?:{line?:number;column?:number})=>void;onClose:()=>void;mode?:'open'|'pick'}) {
 const key = `${scope.projectId}\0${scope.worktreePath ?? ''}`;
 const [files, setFiles] = useState(() => cache.get(key));
 const [query, setQuery] = useState('');
 const [active, setActive] = useState(0);
 const [issue, setIssue] = useState<string>();
 const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
 const panel = useRef<HTMLElement>(null);
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
 const parsed = splitQuickOpenQuery(query);
 const matches = useMemo(() => files ? fuzzyFilter(files.paths, parsed.query, 60) : [], [files, parsed.query]);
 useEffect(() => setActive(0), [parsed.query]);
 useEffect(() => { list.current?.querySelector<HTMLElement>('.cmd-row.active')?.scrollIntoView({block:'nearest'}); }, [active]);
 const choose = (path:string) => { onClose(); onOpen(path, mode === 'open' && parsed.line ? {line:parsed.line, column:parsed.column} : undefined); };
 return <div className="scrim shell-palette-scrim" onMouseDown={event => { if(event.target === event.currentTarget) onClose(); }}>
  <section ref={panel} className="dialog palette wb-quick-open" role="dialog" aria-modal="true" aria-label={mode === 'pick' ? text('Add to Plans & docs', '添加到计划与文档') : text('Go to file', '转到文件')}>
   <input ref={input} className="palette-input" value={query} placeholder={mode === 'pick' ? text('Search files to add', '搜索要添加的文件') : text('Search files by name (append :line to jump)', '按文件名搜索（末尾加 :行号 可跳转）')}
    aria-label={text('File name', '文件名')} aria-controls="wb-quick-open-results" aria-activedescendant={matches[active] ? `wb-qo-${active}` : undefined}
    onChange={event => setQuery(event.target.value)}
    onKeyDown={event => {
     if(event.key === 'Escape') { event.preventDefault(); onClose(); }
     else if(event.key === 'ArrowDown') { event.preventDefault(); setActive(value => Math.min(matches.length - 1, value + 1)); }
     else if(event.key === 'ArrowUp') { event.preventDefault(); setActive(value => Math.max(0, value - 1)); }
     else if(event.key === 'Enter' && matches[active]) { event.preventDefault(); choose(matches[active].path); }
    }}/>
   <div className="palette-results" id="wb-quick-open-results" role="listbox" ref={list}>
    {issue && <p className="palette-empty" role="alert">{issue}</p>}
    {!files && !issue && <p className="palette-empty">{text('Indexing files…', '正在读取文件列表…')}</p>}
    {matches.map((match, index) => <button type="button" role="option" aria-selected={index === active} id={`wb-qo-${index}`} key={match.path}
     className={`cmd-row${index === active ? ' active' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => choose(match.path)} title={match.path}>
     <Icon name="file"/><Highlighted path={match.path} positions={match.positions}/>
    </button>)}
    {files && !matches.length && <p className="palette-empty">{text('No matching files.', '没有匹配的文件。')}</p>}
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
