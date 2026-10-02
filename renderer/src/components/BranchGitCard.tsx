import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitCommitInfo, GitStatus } from '@threadterm/protocol';
import { request } from '../bridge';
import { branchSync, changeNote, listedChanges, summarizeChanges } from '../branchGit';
import { isUnavailable, workbenchError } from '../workbench/errors';
import { WbIcon } from '../workbench/icons';
import { FILES_CHANGED_EVENT, baseName, parentPath } from '../workbench/types';
import { relativeTime } from './CodeEditor';
import { Icon } from './PrototypeIcon';
import '../workbench/workbench.css';

const FILE_LIMIT = 5, COMMIT_LIMIT = 3;

type Props = {
 projectId:string; worktreePath:string; revision:number; zh:boolean;
 /** Opens the Changes page, on one file's diff when a target is given. */
 onOpenChanges:(target?:{path:string;staged:boolean}) => void;
};
type State = { loaded:boolean; status?:GitStatus; commits?:GitCommitInfo[]; error?:string; unavailable?:boolean };

/**
 * Branch home card: upstream sync, uncommitted changes and recent commits of the branch's worktree. Read-only.
 * Refreshed when opened, on window focus, after in-app file writes and on snapshot revisions; no background poll.
 * Hidden when the folder is not a Git repository.
 */
export function BranchGitCard({projectId, worktreePath, revision, zh, onOpenChanges}:Props) {
 const [state, setState] = useState<State>({loaded:false});
 const scopeKey = `${projectId}\0${worktreePath}`;
 const latest = useRef(0);
 const load = useCallback(async () => {
  const id = ++latest.current, params = {projectId, worktreePath};
  const [status, log] = await Promise.allSettled([request('git.status', params), request('git.log', {...params, limit:COMMIT_LIMIT})]);
  if(id !== latest.current) return;
  if(status.status === 'rejected') { setState({loaded:true, unavailable:isUnavailable(status.reason), error:workbenchError(status.reason, zh)}); return; }
  // A reply without a change list (a stub bridge) hides the card rather than throwing during render.
  if(!Array.isArray(status.value?.changes)) { setState({loaded:true, unavailable:true}); return; }
  // A runtime without git.log still shows the status half.
  const commits = log.status === 'fulfilled' && Array.isArray(log.value?.commits) ? log.value.commits : undefined;
  setState({loaded:true, status:status.value, commits});
 }, [projectId, worktreePath, zh]);
 useEffect(() => { setState({loaded:false}); }, [scopeKey]);
 useEffect(() => { void load(); }, [load, revision]);
 useEffect(() => {
  const again = () => void load();
  addEventListener('focus', again); addEventListener(FILES_CHANGED_EVENT, again);
  return () => { removeEventListener('focus', again); removeEventListener(FILES_CHANGED_EVENT, again); };
 }, [load]);
 if(state.unavailable) return null;

 const {status, commits} = state;
 const summary = status && summarizeChanges(status.changes), note = summary ? changeNote(summary, zh) : '';
 const files = status ? listedChanges(status.changes, FILE_LIMIT) : [], more = (summary?.total ?? 0) - files.length;
 const sync = status && branchSync(status);
 const syncLine = !sync ? null
  : sync.kind === 'detached' ? <><Icon name="branch"/><span>{zh ? '游离 HEAD：当前不在任何分支上' : 'Detached HEAD — not on a branch'}</span></>
  : sync.kind === 'unpublished' ? <><Icon name="branch"/><span>{zh ? '尚未发布：此分支没有上游分支' : 'Not published — this branch has no upstream'}</span></>
  : sync.kind === 'synced' ? <><Icon name="check" className="ov-git-ok"/><span>{zh ? '已与' : 'Up to date with'} <span className="mono">{sync.upstream}</span>{zh ? ' 同步' : ''}</span></>
  : <><Icon name="branch"/><span className="mono">{sync.upstream}</span>
    {sync.ahead > 0 && <span className="ov-git-chip" title={zh ? `${sync.ahead} 个提交待推送` : `${sync.ahead} ${sync.ahead === 1 ? 'commit' : 'commits'} to push`}><WbIcon name="push"/>{zh ? `${sync.ahead} 个待推送` : `${sync.ahead} to push`}</span>}
    {sync.behind > 0 && <span className="ov-git-chip" title={zh ? `${sync.behind} 个提交待拉取` : `${sync.behind} ${sync.behind === 1 ? 'commit' : 'commits'} to pull`}><WbIcon name="pull"/>{zh ? `${sync.behind} 个待拉取` : `${sync.behind} to pull`}</span>}</>;

 return <section className="ov-sec ov-sec-git" data-testid="home-git">
  <header className="ov-sec-head"><h2>Git</h2><button className="btn btn-ghost ov-head-btn" onClick={() => onOpenChanges()}>{zh ? '查看更改' : 'Changes'}</button></header>
  {state.error
   ? <p className="ov-empty ov-git-error" role="alert"><span>{state.error}</span><button className="btn btn-sm" onClick={() => void load()}>{zh ? '重试' : 'Retry'}</button></p>
   : !state.loaded || !status ? <p className="ov-empty">{zh ? '正在读取 Git 状态…' : 'Reading Git status…'}</p>
   : <>
    <div className="ov-git-sync" data-testid="home-git-sync">{syncLine}</div>
    <div className="ov-git-cols">
     <div className="ov-git-col" data-testid="home-git-changes">
      <h3 className="ov-git-label"><span>{zh ? '未提交的更改' : 'Uncommitted changes'}</span>{summary!.total > 0 && <span className="count">{summary!.total}</span>}{note && <span className="ov-git-note">{note}</span>}</h3>
      {files.length
       ? <div className="ov-list">
         {files.map(({change, decoration, stagedOnly, partlyStaged}) => <button type="button" key={change.path} className={`ov-row ov-git-file tone-${decoration.tone}`} title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path} onClick={() => onOpenChanges({path:change.path, staged:stagedOnly})}>
          <span className="wb-deco" aria-hidden="true">{decoration.letter}</span>
          <span className="ov-git-path"><span className="ov-git-name">{baseName(change.path)}</span><span className="ov-git-dir">{parentPath(change.path)}</span></span>
          {(stagedOnly || partlyStaged) && <span className="ov-git-tag">{stagedOnly ? (zh ? '已暂存' : 'staged') : (zh ? '部分暂存' : 'partly staged')}</span>}
          <Icon name="chevR" className="ov-row-go"/>
         </button>)}
         {more > 0 && <button type="button" className="ov-git-more" onClick={() => onOpenChanges()}>{zh ? `还有 ${more} 个文件` : `${more} more ${more === 1 ? 'file' : 'files'}`}</button>}
        </div>
       : <p className="ov-empty ov-git-clean"><Icon name="check" className="ov-git-ok"/>{zh ? '没有未提交的更改' : 'No uncommitted changes'}</p>}
     </div>
     {commits && <div className="ov-git-col" data-testid="home-git-commits">
      <h3 className="ov-git-label"><span>{zh ? '最近提交' : 'Recent commits'}</span></h3>
      {commits.length
       ? <div className="ov-list">{commits.map(commit => <div key={commit.hash} className="ov-row ov-git-commit" title={commit.subject}>
         <WbIcon name="checkpoint"/>
         <span className="ov-row-main"><span className="ov-row-title">{commit.subject}</span><span className="ov-row-ctx"><span className="mono">{commit.hash.slice(0, 7)}</span> · {commit.authorName} · {relativeTime(commit.authoredAt, zh)}</span></span>
        </div>)}</div>
       : <p className="ov-empty">{zh ? '还没有提交。' : 'No commits yet.'}</p>}
     </div>}
    </div>
   </>}
 </section>;
}
