import { useEffect, useMemo, useRef, useState } from 'react';
import type { GitCommitDetail, GitCommitInfo, GitTextPair } from '@threadterm/protocol';
import { request } from '../bridge';
import { Icon } from './PrototypeIcon';
import { MergeEditor } from './MergeEditor';
import { relativeTime } from './CodeEditor';
import { workbenchError } from '../workbench/errors';
import { baseName, parentPath } from '../workbench/types';
import { commitGraph, refBadge, type GraphRow } from '../workbench/gitGraph';
import '../workbench/workbench.css';

const PAGE = 100;
const SCOPE_KEY = 'threadterm.workbench.historyScope';
const ROW = 44, LANE = 14, MAX_LANES = 12;
const laneX = (column:number) => 9 + Math.min(column, MAX_LANES - 1) * LANE;

/** One row's slice of the commit graph; rows are a fixed height so the slices join into continuous lines. */
function GraphCell({row, width, head}:{row:GraphRow;width:number;head:boolean}) {
 const mid = ROW / 2;
 const curve = (from:number, to:number, y1:number, y2:number) => {
  const x1 = laneX(from), x2 = laneX(to), bend = (y1 + y2) / 2;
  return from === to ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${bend} ${x2} ${bend} ${x2} ${y2}`;
 };
 return <svg className="wb-graph" width={laneX(Math.min(width, MAX_LANES) - 1) + 9} height={ROW} aria-hidden="true">
  {row.edges.map((edge, index) => <path key={index} className={`lane-${edge.color % 8}`} d={edge.half === 'top' ? curve(edge.from, edge.to, 0, mid) : curve(edge.from, edge.to, mid, ROW)}/>)}
  <circle className={`wb-graph-node lane-${row.color % 8}${head ? ' head' : ''}`} cx={laneX(row.node)} cy={mid} r={head ? 5 : 4}/>
 </svg>;
}

export function GitHistoryView({projectId, worktreePath, path, focusCommit, zh, onOpenFile}:{projectId:string;worktreePath?:string;path?:string;focusCommit?:string;zh:boolean;onOpenFile?:(path:string)=>void}) {
 const scope = {projectId, ...(worktreePath ? {worktreePath} : {})};
 const [commits, setCommits] = useState<GitCommitInfo[]>([]);
 const [hasMore, setHasMore] = useState(false);
 const [selected, setSelected] = useState<string>();
 const [detail, setDetail] = useState<GitCommitDetail>();
 const [file, setFile] = useState<{path:string;originalPath?:string}>();
 const [pair, setPair] = useState<GitTextPair>();
 const [issue, setIssue] = useState<string>();
 const [loading, setLoading] = useState(false);
 // Repository history is drawn as a graph of the current branch or of every branch; file history is a plain list.
 const [allBranches, setAllBranches] = useState(() => { try { return localStorage.getItem(SCOPE_KEY) === 'all'; } catch { return false; } });
 const [remoteBranches, setRemoteBranches] = useState<ReadonlySet<string>>(new Set());
 const [notice, setNotice] = useState<string>();
 const generation = useRef(0), fileGeneration = useRef(0), pageGeneration = useRef(0);
 const all = !path && allBranches;
 const graph = useMemo(() => path ? undefined : commitGraph(commits), [commits, path]);
 const text = (en:string, cn:string) => zh ? cn : en;
 const loadPage = async (skip:number) => {
  const ticket = skip ? pageGeneration.current : ++pageGeneration.current;
  setLoading(true);
  const params = {...scope, ...(path ? {path} : {}), skip, limit:PAGE};
  const restart = text('Restart ThreadTerm to show all branches; showing the current branch.', '重启 ThreadTerm 后才能显示所有分支；当前显示的是当前分支。');
  try {
   let value;
   // An older app rejects the `all` field and an older runtime ignores it (no `scope`): fall back to HEAD and say so.
   try { value = await request('git.log', all ? {...params, all:true} : params); }
   catch(error) { if(!all) throw error; value = await request('git.log', params); value = {...value, scope:undefined}; }
   if(ticket !== pageGeneration.current) return;
   setNotice(all && value.scope !== 'all' ? restart : undefined);
   setCommits(current => skip ? [...current, ...value.commits] : value.commits);
   setHasMore(value.hasMore);
   if(!skip && value.commits[0]) setSelected(current => current ?? focusCommit ?? value.commits[0].hash);
  } catch(error) { setIssue(workbenchError(error, zh)); }
  finally { setLoading(false); }
 };
 useEffect(() => { setCommits([]); setSelected(focusCommit); setDetail(undefined); void loadPage(0); }, [projectId, worktreePath, path, all]);
 useEffect(() => {
  if(path) return;
  let live = true;
  void request('git.branches', scope).then(value => { if(live) setRemoteBranches(new Set(value.branches.filter(branch => branch.remote).map(branch => branch.name))); }).catch(() => {});
  return () => { live = false; };
 }, [projectId, worktreePath, path]);
 const chooseScope = (next:boolean) => { setAllBranches(next); try { localStorage.setItem(SCOPE_KEY, next ? 'all' : 'head'); } catch { /* keep in memory */ } };
 useEffect(() => { if(focusCommit) setSelected(focusCommit); }, [focusCommit]);
 useEffect(() => {
  if(!selected) return;
  const ticket = ++generation.current;
  setDetail(undefined); setPair(undefined); setFile(undefined);
  void request('git.commit.show', {...scope, commit:selected}).then(value => {
   if(ticket !== generation.current) return;
   setDetail(value);
   // File history opens the followed file directly; otherwise the first changed file.
   const initial = (path && value.files.find(candidate => candidate.path === path)) || value.files[0];
   if(initial) setFile({path:initial.path, originalPath:initial.originalPath});
  }).catch(error => { if(ticket === generation.current) setIssue(workbenchError(error, zh)); });
 }, [selected, projectId, worktreePath]);
 useEffect(() => {
  if(!selected || !file) return;
  const ticket = ++fileGeneration.current;
  setPair(undefined);
  void request('git.commit.diff', {...scope, commit:selected, path:file.path, ...(file.originalPath ? {originalPath:file.originalPath} : {})})
   .then(value => { if(ticket === fileGeneration.current) setPair(value); })
   .catch(error => { if(ticket === fileGeneration.current) setIssue(workbenchError(error, zh)); });
 }, [selected, file?.path]);
 const info = detail?.commit;
 return <section className={`wb-history${graph ? ' graph' : ''}`} aria-label={path ? text(`History of ${path}`, `${path} 的历史`) : text('Git history', 'Git 历史')}>
  <div className="wb-history-list" role="listbox" aria-label={text('Commits', '提交')}>
   <header className="wb-history-title"><Icon name="clock"/><strong>{path ? baseName(path) : text('History', '提交历史')}</strong>{path && <span className="wb-dir" title={path}>{parentPath(path)}</span>}
    {!path && <div className="seg wb-history-scope" role="radiogroup" aria-label={text('History scope', '历史范围')}>
     <button type="button" role="radio" aria-checked={!allBranches} className={`seg-btn${allBranches ? '' : ' active'}`} onClick={() => chooseScope(false)}>{text('Current branch', '当前分支')}</button>
     <button type="button" role="radio" aria-checked={allBranches} className={`seg-btn${allBranches ? ' active' : ''}`} onClick={() => chooseScope(true)}>{text('All branches', '所有分支')}</button>
    </div>}</header>
   {notice && <p className="wb-notice" role="status">{notice}</p>}
   {issue && <p className="wb-issue" role="alert">{issue}<button type="button" className="icon-btn" aria-label={text('Dismiss', '关闭提示')} onClick={() => setIssue(undefined)}><Icon name="close"/></button></p>}
   {commits.map((commit, index) => <button type="button" role="option" aria-selected={commit.hash === selected} key={commit.hash}
    className={`wb-commit-row${commit.hash === selected ? ' selected' : ''}`} onClick={() => setSelected(commit.hash)}>
    {graph ? <GraphCell row={graph.rows[index]} width={graph.width} head={commit.refs.some(ref => ref === 'HEAD' || ref.startsWith('HEAD -> '))}/>
     : <span className={`wb-lane${commit.parents.length > 1 ? ' merge' : ''}`} aria-hidden="true"/>}
    <span className="wb-commit-text">
     <span className="wb-commit-line"><span className="wb-commit-subject">{commit.subject || text('(no message)', '（无说明）')}</span>
      {commit.refs.map(ref => { const badge = refBadge(ref, remoteBranches); return <span key={ref} className={`wb-ref ${badge.kind}`} title={ref}>{badge.label}</span>; })}</span>
     <span className="wb-commit-meta">{commit.authorName} · {relativeTime(commit.authoredAt, zh)} · <code>{commit.hash.slice(0, 7)}</code></span>
    </span>
   </button>)}
   {!commits.length && !loading && !issue && <p className="wb-empty">{text('No commits yet.', '还没有提交。')}</p>}
   {hasMore && <button type="button" className="btn btn-sm wb-more" disabled={loading} onClick={() => void loadPage(commits.length)}>{loading ? text('Loading…', '正在读取…') : text('Load more', '加载更多')}</button>}
  </div>
  <div className="wb-history-detail">
   {info ? <>
    <header className="wb-commit-head">
     <strong>{info.subject}</strong>
     <span className="wb-commit-meta">{info.authorName} &lt;{info.authorEmail}&gt; · {new Date(info.authoredAt).toLocaleString()} · <code title={info.hash}>{info.hash.slice(0, 10)}</code>
      <button type="button" className="icon-btn" title={text('Copy commit hash', '复制提交哈希')} aria-label={text('Copy commit hash', '复制提交哈希')} onClick={() => void navigator.clipboard.writeText(info.hash)}><Icon name="export"/></button></span>
     {detail?.body && <pre className="wb-commit-body">{detail.body}</pre>}
    </header>
    <div className="wb-commit-files" role="list">
     {detail?.files.map(candidate => <button type="button" role="listitem" key={candidate.path} className={`wb-change-row tone-${candidate.status === 'A' ? 'added' : candidate.status === 'D' ? 'deleted' : candidate.status === 'R' ? 'renamed' : 'modified'}${file?.path === candidate.path ? ' selected' : ''}`}
      title={candidate.originalPath ? `${candidate.originalPath} → ${candidate.path}` : candidate.path} onClick={() => setFile({path:candidate.path, originalPath:candidate.originalPath})}>
      <Icon name="file"/><span className="wb-name">{baseName(candidate.path)}</span><span className="wb-dir">{parentPath(candidate.path)}</span><span className="wb-deco">{candidate.status}</span>
     </button>)}
     {detail && !detail.files.length && <p className="wb-empty">{text('No file changes in this folder.', '此目录中没有文件更改。')}</p>}
    </div>
    <div className="wb-history-diff">
     {file && <div className="file-bar"><span className="path" title={file.path}>{file.path}</span><span className="grow"/>{onOpenFile && <button type="button" className="btn btn-sm" onClick={() => onOpenFile(file.path)}>{text('Open current file', '打开当前文件')}</button>}</div>}
     {pair?.binary ? <p className="tt-editor-state">{text('Binary file — no text diff.', '二进制文件，无法显示文本对比。')}</p>
      : pair ? <MergeEditor path={pair.path} oldText={pair.oldText} newText={pair.newText} readOnly onChange={() => {}} onSave={() => {}}/>
      : file ? <p className="tt-editor-state">{text('Loading diff…', '正在读取对比…')}</p> : null}
    </div>
   </> : <p className="tt-editor-state">{selected ? text('Loading commit…', '正在读取提交…') : text('Select a commit.', '选择一个提交。')}</p>}
  </div>
 </section>;
}
