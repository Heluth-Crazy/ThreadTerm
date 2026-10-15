import { Select } from "./ui/Select";
import { useEffect, useMemo, useState } from 'react';
import type { SessionStatus, Snapshot } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { useTranslation } from '../i18n';
import { displayPath } from '../projectScope';
import { filterSessionHistory, nextSelection, projectLabel, type HistoryScope } from './sessionHistory';
import { SurfaceDialog } from './SurfaceDialog';
import { HistoryRail } from './HistoryRail';
import './history-rail.css';

const statuses: SessionStatus[] = ['starting', 'running', 'idle', 'waiting', 'exited', 'interrupted', 'error'];

export type SessionHistoryRailProps = {
  data: Snapshot;
  onClose?: () => void;
  onNavigateAll: (sessionId: string, scope: 'all' | 'archived') => void;
  onChanged: () => void;
};

export function SessionHistoryRail({ data, onClose, onNavigateAll, onChanged }: SessionHistoryRailProps) {
  const { locale, formatDate } = useTranslation();
  const zh = locale === 'zh-CN';
  const copy = (english: string, chinese: string) => zh ? chinese : english;
  const [source, setSource] = useState<'native' | 'saved'>('native');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<HistoryScope>('all');
  const [projectId, setProjectId] = useState('');
  const [worktreePath, setWorktreePath] = useState('');
  const [status, setStatus] = useState<SessionStatus | ''>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [issue, setIssue] = useState<string>();
  const records = useMemo(() => filterSessionHistory(data.sessions, query, scope, projectId, worktreePath, status), [data.sessions, query, scope, projectId, worktreePath, status]);
  const worktrees = useMemo(() => [...new Set(data.sessions.filter(session => !projectId || session.projectId === projectId).map(session => session.worktreePath).filter((path): path is string => Boolean(path)))].sort(), [data.sessions, projectId]);
  const selectedSessions = records.filter(session => selected.has(session.id));
  useEffect(() => { setSelected(new Set()); }, [query, scope, projectId, worktreePath, status]);
  const toggle = (id: string) => setSelected(current => nextSelection(current, id));
  const updateFollow = async (followed: boolean) => {
    const targets = selectedSessions.filter(session => session.followed !== followed);
    if (!targets.length) return;
    setIssue(undefined);
    try {
      const results = await Promise.allSettled(targets.map(session => request('session.update', { sessionId: session.id, followed, operationId: operationId() })));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (results.length !== failures.length) { setSelected(new Set()); onChanged(); }
      if (failures.length) throw failures[0].reason;
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : copy('Some followed sessions could not be updated.', '部分已关注会话无法更新。')); }
  };
  const toggleBookmark = async (sessionId: string) => {
    const session = data.sessions.find(item => item.id === sessionId);
    if (!session) return;
    setIssue(undefined);
    try {
      await request('session.organize', { sessionId, bookmarked: !session.bookmarked, expectedRevision: session.organizationRevision ?? 0, operationId: operationId() });
      onChanged();
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : copy('Could not update the bookmark.', '无法更新书签。')); }
  };
  return <SurfaceDialog title={copy('Local history', '本机历史')} subtitle={copy('Native sessions and saved ThreadTerm records.', '本机会话与 ThreadTerm 保存记录')} icon="archive" size="wide" className="local-history-dialog sheet-fill sheet-edge-to-edge" onClose={() => onClose?.()}>
    <div className="history-source-switch" role="group" aria-label={copy('History source', '历史来源')}>
      <div className="seg"><button className={`seg-btn btn-tab${source === 'native' ? ' active' : ''}`} aria-pressed={source === 'native'} onClick={() => setSource('native')}>{copy('Native sessions', '本机会话')}</button>
      <button className={`seg-btn btn-tab${source === 'saved' ? ' active' : ''}`} aria-pressed={source === 'saved'} onClick={() => setSource('saved')}>{copy('ThreadTerm records', 'ThreadTerm 记录')}</button>
      </div>
    </div>
    {source === 'native' ? <HistoryRail onPresented={onClose} /> : <aside className="history-rail session-history-rail" aria-label={copy('Session history', '会话历史')}>
    <header className="history-rail-heading"><div><h3>{copy('ThreadTerm records', 'ThreadTerm 记录')}</h3><p>{copy('Saved sessions, bookmarks, and archived records.', '已保存的会话、书签和归档记录。')}</p></div></header>
    <div className="history-tools history-saved-filters">
      <label className="history-search-label">{copy('Search', '搜索')}<input aria-label={copy('Search history', '搜索历史')} value={query} onChange={event => setQuery(event.target.value)} placeholder={copy('Title, provider, or directory', '标题、提供方或目录')} /></label>
      <label>{copy('Records', '记录范围')}<Select aria-label={copy('History scope', '历史范围')} value={scope} onChange={event => { setScope(event.target.value as HistoryScope); setSelected(new Set()); }}><option value="all">{copy('All history', '全部历史')}</option><option value="bookmarked">{copy('Bookmarks', '书签')}</option><option value="archived">{copy('Archived', '已归档')}</option></Select></label>
      <label>{copy('Project', '项目')}<Select aria-label={copy('Project', '项目')} value={projectId} onChange={event => { setProjectId(event.target.value); setWorktreePath(''); }}><option value="">{copy('All projects', '全部项目')}</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</Select></label>
      <label>{copy('Worktree', '工作树')}<Select aria-label={copy('Worktree', '工作树')} value={worktreePath} onChange={event => setWorktreePath(event.target.value)}><option value="">{copy('All worktrees', '全部工作树')}</option>{worktrees.map(path => <option key={path} value={path}>{displayPath(path)}</option>)}</Select></label>
      <label>{copy('Status', '状态')}<Select aria-label={copy('Status', '状态')} value={status} onChange={event => setStatus(event.target.value as SessionStatus | '')}><option value="">{copy('All statuses', '全部状态')}</option>{statuses.map(value => <option key={value} value={value}>{zh ? ({ starting: '启动中', running: '运行中', idle: '空闲', waiting: '等待中', exited: '已结束', interrupted: '已中断', error: '错误' })[value] : value}</option>)}</Select></label>
    </div>
    {selected.size > 0 && <div className="history-bulk" role="group" aria-label={copy('Selected history actions', '已选择历史操作')}><span>{selected.size} {copy('selected', '项已选择')}</span><button className="btn btn-sm" onClick={() => void updateFollow(true)}>{copy('Follow selected', '关注所选')}</button><button className="btn btn-sm" onClick={() => void updateFollow(false)}>{copy('Unfollow selected', '取消关注所选')}</button><button className="btn btn-sm" onClick={() => setSelected(new Set())}>{copy('Clear', '清除')}</button></div>}
    {issue && <p role="alert" className="surface-error">{issue}</p>}
    <div className="history-list history-native-list">{records.map(session => <article key={session.id}><label><input type="checkbox" aria-label={`${copy('Select', '选择')} ${session.title}`} checked={selected.has(session.id)} onChange={() => toggle(session.id)} /></label><button className="history-row-main" onClick={() => { onClose?.(); onNavigateAll(session.id, session.archived ? 'archived' : 'all'); }}><strong>{session.bookmarked && '★ '}{session.title}</strong><span>{projectLabel(data.projects, session.projectId, copy('Unattributed', '未归属'))} · {session.status}</span><small>{displayPath(session.worktreePath) || copy('No worktree', '无工作树')} · {formatDate(session.updatedAt)}</small></button><div className="history-row-actions"><button className="btn btn-sm" onClick={() => void toggleBookmark(session.id)} aria-pressed={Boolean(session.bookmarked)}>{session.bookmarked ? copy('Unbookmark', '移除书签') : copy('Bookmark', '加入书签')}</button></div></article>)}{!records.length && <p className="history-empty">{copy('No history matches these filters.', '没有符合这些筛选条件的历史。')}</p>}</div>
  </aside>}
  </SurfaceDialog>;
}
