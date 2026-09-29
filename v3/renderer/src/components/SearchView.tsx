import { useEffect, useRef, useState } from 'react';
import type { SearchResult } from '@threadterm/protocol';
import { request } from '../bridge';
import { Icon } from './PrototypeIcon';
import { workbenchError } from '../workbench/errors';
import { baseName, parentPath, scopeParams, type WorkbenchActions, type WorkbenchScope } from '../workbench/types';

type Options = { regex:boolean; caseSensitive:boolean; wholeWord:boolean };

/** Highlights the match inside the preview using UTF-16 offsets from the runtime. */
function Preview({preview, column, length}:{preview:string;column:number;length:number}) {
 const before = preview.slice(0, column), hit = preview.slice(column, column + length), after = preview.slice(column + length);
 return <span className="wb-match-text">{before.trimStart()}<mark>{hit}</mark>{after}</span>;
}

export function SearchView({scope, actions, zh, focusKey}:{scope:WorkbenchScope;actions:WorkbenchActions;zh:boolean;focusKey?:string}) {
 const [query, setQuery] = useState('');
 const [options, setOptions] = useState<Options>({regex:false, caseSensitive:false, wholeWord:false});
 const [filters, setFilters] = useState(false);
 const [include, setInclude] = useState('');
 const [exclude, setExclude] = useState('');
 const [result, setResult] = useState<SearchResult>();
 const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
 const [issue, setIssue] = useState<string>();
 const [loading, setLoading] = useState(false);
 const generation = useRef(0);
 const input = useRef<HTMLInputElement>(null);
 const text = (en:string, cn:string) => zh ? cn : en;
 useEffect(() => { if(focusKey) { input.current?.focus(); input.current?.select(); } }, [focusKey]);
 useEffect(() => {
  const ticket = ++generation.current;
  if(!query.trim()) { setResult(undefined); setIssue(undefined); setLoading(false); return; }
  setLoading(true);
  const timer = setTimeout(() => {
   void request('filesystem.search', {...scopeParams(scope), query, ...options, ...(include.trim() ? {include} : {}), ...(exclude.trim() ? {exclude} : {})})
    .then(value => { if(ticket === generation.current) { setResult(value); setIssue(undefined); setCollapsed(new Set()); } })
    .catch(error => { if(ticket === generation.current) { setResult(undefined); setIssue(workbenchError(error, zh)); } })
    .finally(() => { if(ticket === generation.current) setLoading(false); });
  }, 300);
  return () => clearTimeout(timer);
 }, [query, options.regex, options.caseSensitive, options.wholeWord, include, exclude, scope.projectId, scope.worktreePath]);
 const total = result?.files.reduce((sum, file) => sum + file.matches.length, 0) ?? 0;
 const toggle = (key:keyof Options, label:string, glyph:string) => <button type="button" className={`wb-toggle${options[key] ? ' on' : ''}`} aria-pressed={options[key]} title={label} aria-label={label} onClick={() => setOptions(current => ({...current, [key]:!current[key]}))}>{glyph}</button>;
 return <div className="wb-search">
  <div className="wb-search-box">
   <div className="wb-search-field">
    <input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder={text('Search in files', '在文件中搜索')} aria-label={text('Search in files', '在文件中搜索')}
     onKeyDown={event => { if(event.key === 'Escape' && query) { event.preventDefault(); setQuery(''); } }}/>
    <div className="wb-toggles">
     {toggle('caseSensitive', text('Match case', '区分大小写'), 'Aa')}
     {toggle('wholeWord', text('Match whole word', '全字匹配'), 'ab')}
     {toggle('regex', text('Use regular expression', '使用正则表达式'), '.*')}
    </div>
   </div>
   <button type="button" className={`wb-link-btn${filters ? ' on' : ''}`} aria-expanded={filters} onClick={() => setFilters(value => !value)}>{text('Files to include / exclude', '包含 / 排除的文件')}</button>
   {filters && <div className="wb-search-filters">
    <input value={include} onChange={event => setInclude(event.target.value)} placeholder={text('e.g. src, *.ts', '例如 src, *.ts')} aria-label={text('Files to include', '包含的文件')}/>
    <input value={exclude} onChange={event => setExclude(event.target.value)} placeholder={text('e.g. dist, *.min.js', '例如 dist, *.min.js')} aria-label={text('Files to exclude', '排除的文件')}/>
   </div>}
  </div>
  {issue && <p className="wb-issue" role="alert">{issue}</p>}
  {result && <p className="wb-summary" aria-live="polite">
   {total ? text(`${total} ${total === 1 ? 'result' : 'results'} in ${result.files.length} ${result.files.length === 1 ? 'file' : 'files'}`, `${result.files.length} 个文件中 ${total} 个结果`) : text('No results.', '没有结果。')}
   {result.truncated && <span className="wb-warn">{text(' · Results truncated; refine the search.', ' · 结果已截断，请缩小搜索范围。')}</span>}
  </p>}
  {loading && !result && <p className="wb-summary">{text('Searching…', '正在搜索…')}</p>}
  <div className="wb-results" role="tree" aria-label={text('Search results', '搜索结果')}>
   {result?.files.map(file => {
    const closed = collapsed.has(file.path);
    return <div key={file.path} className="wb-result-file" role="treeitem" aria-expanded={!closed}>
     <button type="button" className="wb-result-head" title={file.path} onClick={() => setCollapsed(current => { const next = new Set(current); if(next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; })}>
      <span className={`wb-chevron${closed ? '' : ' open'}`} aria-hidden="true"><Icon name="chevR"/></span>
      <Icon name="file"/><span className="wb-name">{baseName(file.path)}</span><span className="wb-dir">{parentPath(file.path)}</span><span className="wb-count">{file.matches.length}</span>
     </button>
     {!closed && <div role="group">{file.matches.map(match => <button type="button" role="treeitem" key={`${match.line}:${match.column}`} className="wb-result-line" title={`${file.path}:${match.line}:${match.column}`}
      onClick={() => actions.openFile(file.path, {line:match.line, column:match.column})}>
      <span className="wb-line-no">{match.line}</span><Preview preview={match.preview} column={match.previewColumn} length={match.length}/>
     </button>)}</div>}
    </div>;
   })}
  </div>
  {!query.trim() && <p className="wb-empty">{text('Search is gitignore-aware and skips binary files and files over 1 MB.', '搜索会遵循 .gitignore，并跳过二进制文件和超过 1 MB 的文件。')}</p>}
 </div>;
}
