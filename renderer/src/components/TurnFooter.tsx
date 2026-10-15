import { lazy, Suspense, useId, useRef, useState } from 'react';
import type { ChatItem, FileReference, ReviewFile, Session } from '@threadterm/protocol';
import { request, revealFile } from '../bridge';
import { createTurnChangesCache, turnFooterSegments, turnReview } from '../turnFooter';
import { SurfaceDialog } from './SurfaceDialog';
import './turn-footer.css';

const ReviewDiffView = lazy(async () => ({ default: (await import('./ReviewDiffView')).ReviewDiffView }));
export type TurnChangesCache = ReturnType<typeof createTurnChangesCache<ReviewFile[]>>;
type Copy = (en: string, zh: string) => string;

export function TurnFooter({ items, elapsedMs, session, zh, copy, cache, openFile }: {
  items: readonly ChatItem[]; elapsedMs?: number; session: Session; zh: boolean; copy: Copy;
  cache: TurnChangesCache; openFile?: (reference: FileReference) => void;
}) {
  const segments = turnFooterSegments(items, elapsedMs, zh);
  const review = turnReview(items);
  const id = useId(), toggle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [files, setFiles] = useState<ReviewFile[]>();
  const [loading, setLoading] = useState(false), [issue, setIssue] = useState<string>();
  const [diff, setDiff] = useState<string>();
  const valid = review && review.from && review.to && review.fileCount > 0;
  const load = () => {
    if (!valid || loading || files) return;
    setLoading(true); setIssue(undefined);
    void cache.load(`${session.id}:${review.from}:${review.to}`, async () => (await request('review.changes', {
      sessionId: session.id, from: review.from, to: review.to,
    })).files).then(setFiles).catch(() => setIssue(copy('Files could not be loaded.', '无法读取文件更改。'))).finally(() => setLoading(false));
  };
  if (!segments.length && !valid) return null;
  return <footer className="chat-turn-footer" data-testid="chat-turn-footer" onKeyDown={event => {
    if (event.key === 'Escape' && open && !diff) { event.stopPropagation(); setOpen(false); toggle.current?.focus(); }
  }}>
    {!!segments.length && <p className="chat-turn-meta" aria-label={segments.map(segment => segment.text).join(' · ')} title={segments.map(segment => segment.text).join(' · ')}>
      {segments.map(segment => <span className={`chat-turn-segment is-${segment.kind}`} key={segment.kind}>{segment.text}</span>)}
    </p>}
    {valid && <>
      <button ref={toggle} type="button" className="btn btn-sm btn-ghost" aria-expanded={open} aria-controls={id} onClick={() => { if (!open) load(); setOpen(value => !value); }}>
        {copy(`Files changed (${review.fileCount})`, `更改文件（${review.fileCount}）`)}
      </button>
      {open && <div id={id} className="chat-turn-files" data-testid="chat-turn-files">
        {loading && <p role="status">{copy('Loading files…', '正在读取文件…')}</p>}
        {issue && <div role="alert"><p>{issue}</p><button type="button" className="btn btn-sm" onClick={load}>{copy('Retry', '重试')}</button></div>}
        {files?.length === 0 && <p>{copy('No file changes.', '没有文件更改。')}</p>}
        {files?.map(file => <div className="chat-turn-file" key={file.path}>
          <div className="chat-turn-file-heading"><span title={file.path}>{file.path}</span><span className="chat-turn-file-counts">{file.binary ? copy('Binary', '二进制') : `+${file.added ?? 0} −${file.removed ?? 0}`}</span></div>
          <div className="chat-turn-file-actions">
            {session.projectId && <button type="button" className="btn btn-sm" onClick={() => setDiff(file.path)}>{copy('Open diff', '查看差异')}</button>}
            {openFile && file.status !== 'D' && <button type="button" className="btn btn-sm" onClick={() => openFile({ path: file.path })}>{copy('Open in editor', '在编辑器中打开')}</button>}
            <button type="button" className="btn btn-sm" aria-label={copy('Reveal in Explorer', '在资源管理器中显示')} onClick={() => void revealFile(session.id, file.path).catch(() => setIssue(copy('File could not be revealed.', '无法在文件管理器中显示文件。')))}>{copy('Reveal', '显示位置')}</button>
          </div>
        </div>)}
      </div>}
      {diff && session.projectId && <SurfaceDialog title={copy('Turn changes', '本回合更改')} subtitle={diff} size="wide" onClose={() => setDiff(undefined)} className="chat-turn-diff-dialog sheet-fill sheet-edge-to-edge">
        <Suspense fallback={<p role="status">{copy('Loading diff…', '正在读取差异…')}</p>}><ReviewDiffView projectId={session.projectId} worktreePath={session.worktreePath} path={diff} sessionId={session.id} checkpointId={review.from} toCheckpointId={review.to} editorId={`turn:${session.id}:${review.from}:${diff}`} zh={zh} onOpenFile={openFile ? path => openFile({ path }) : undefined} /></Suspense>
      </SurfaceDialog>}
    </>}
  </footer>;
}
