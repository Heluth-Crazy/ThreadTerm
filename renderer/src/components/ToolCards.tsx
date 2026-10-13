import { useState } from 'react';
import type { ChatPart, FileReference } from '@threadterm/protocol';
import { diffView, editFileStats, moreFilesLabel, outputView, toolStatusLabel, type DiffView } from '../toolCards';
import { partBody } from '../chatPresentation';
import { isChatImage } from '../chatImages';
import { toolView, type ToolView } from '../toolView';
import { feedbackNotesFromPart } from '../feedbackNotes';
import type { ToolActivityEntry } from '../toolActivity';
import { FileLinkedText, FileReferenceChips } from './FileReferenceText';
import { JsonTree } from './JsonTree';
import { Icon } from './PrototypeIcon';

type Copy = (en: string, zh: string) => string;
type OpenFile = (reference: FileReference) => void;

/** How many edited files render their own diff before "+N more files". */
const EDIT_FILE_LIMIT = 3;

const icons: Record<ToolView['kind'], string> = {
  edit: 'file', command: 'terminal', read: 'file', search: 'search', web: 'popout',
  todo: 'check', skill: 'spark', subagent: 'export', mcp: 'spark', image: 'file',
  compaction: 'layers', generic: 'spark',
};

/** Maps a tool status key to the shared status-chip colours. */
const statusChip: Record<string, string> = {
  running: 'st-running', awaiting: 'st-needs', complete: 'st-ended',
  recorded: 'st-ended', inactive: 'st-ended', failed: 'st-failed', cancelled: 'st-failed',
};

function changeLabel(change: string, copy: Copy): string {
  switch (change) {
    case 'add': return copy('Added', '新增');
    case 'delete': return copy('Deleted', '删除');
    case 'move': return copy('Moved', '移动');
    default: return copy('Modified', '修改');
  }
}

function DiffBlock({ diff, copy, rowLimit }: { diff: NonNullable<Extract<ToolView, { kind: 'edit' }>['files'][number]['diff']>; copy: Copy; rowLimit?: number }) {
  const [showAll, setShowAll] = useState(false);
  const view: DiffView = diffView(diff);
  const cap = rowLimit === undefined ? 2_000 : Math.max(0, rowLimit);
  const rows = (showAll ? view.rows : view.visible).slice(0, cap);
  const budgetLimited = rows.length < (showAll ? view.rows.length : view.visible.length);
  return <div className="tool-diff">
    <div className="tool-diff-rows">
      {rows.map((row, index) => <div className={`tool-diff-line is-${row.kind}`} key={index}>
        <span className="tool-diff-gutter" aria-hidden="true">{row.kind === 'add' ? '' : row.oldLine ?? ''}{row.kind === 'add' ? row.newLine ?? '' : ''}</span>
        <span className="tool-diff-mark" aria-hidden="true">{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : row.kind === 'hunk' ? '' : ' '}</span>
        <span className="tool-diff-text">{row.text}</span>
      </div>)}
    </div>
    {view.collapsed && view.canShowAll && <button type="button" className="btn btn-sm tool-card-action" onClick={() => setShowAll(true)}>{copy(`Show all (${view.rows.length} lines)`, `显示全部（${view.rows.length} 行）`)}</button>}
    {view.openOnly && <p className="tool-card-note">{copy(`Preview is incomplete: ${rows.length} of ${view.rows.length} diff lines are shown.`, `预览不完整：仅显示 ${view.rows.length} 行差异中的 ${rows.length} 行。`)}</p>}
    {budgetLimited && <p className="tool-card-note">{copy('Preview limit reached. Review the request details before deciding.', '已达到预览限制。请在决定前查看请求详情。')}</p>}
  </div>;
}

export function EditBody({ view, copy, openFile, openDiff, canOpenDiff, fileLimit = EDIT_FILE_LIMIT, rowLimits }: { view: Extract<ToolView, { kind: 'edit' }>; copy: Copy; openFile?: OpenFile; openDiff?: (path: string) => void; canOpenDiff?: (path: string) => boolean; fileLimit?: number; rowLimits?: readonly number[] }) {
  const shown = view.files.slice(0, fileLimit);
  const more = moreFilesLabel(shown.length, view.files.length);
  return <>
    {shown.map((file, index) => {
      const stats = editFileStats(file);
      // Only offer Open diff when the working-tree diff can actually open this
      // path; a native absolute path outside the project would only fail.
      const diffable = openDiff && (canOpenDiff ? canOpenDiff(file.path) : true);
      return <div className="tool-edit-file" key={`${file.path}:${index}`}>
        <div className="tool-edit-file-head">
          <Icon name="file" />
          <span className="tool-edit-path"><FileLinkedText text={file.path} openFile={openFile} /></span>
          <span className={`tool-edit-change is-${file.change}`}>{changeLabel(file.change, copy)}</span>
          <span className="tool-edit-counts"><b>+{stats.added}</b> <i>−{stats.removed}</i></span>
        </div>
        {file.movePath && <p className="tool-card-note">→ {file.movePath}</p>}
        {file.diff && <DiffBlock diff={file.diff} copy={copy} rowLimit={rowLimits?.[index]} />}
        {(openFile || diffable) && <div className="tool-card-actions">
          {openFile && <button type="button" className="btn btn-sm tool-card-action" onClick={() => openFile({ path: file.path })}>{copy('Open file', '打开文件')}</button>}
          {diffable && <button type="button" className="btn btn-sm tool-card-action" onClick={() => openDiff!(file.path)}>{copy('Open diff', '查看差异')}</button>}
        </div>}
      </div>;
    })}
    {more && <p className="tool-card-note">{more} {copy('more files', '个文件未显示')}</p>}
    {view.truncated && <p className="tool-card-note">{copy('The provider truncated this edit.', '提供方截断了此修改。')}</p>}
  </>;
}

function OutputBody({ text, copy }: { text: string; copy: Copy }) {
  const [expanded, setExpanded] = useState(false);
  const view = outputView(text, expanded);
  return <>
    <pre className="tool-output">{view.lines.join('\n')}</pre>
    {view.expandable && <button type="button" className="btn btn-sm tool-card-action" onClick={() => setExpanded(true)}>{copy(`Show output (${view.total} lines)`, `显示输出（${view.total} 行）`)}</button>}
    {expanded && view.omitted > 0 && <p className="tool-card-note">{copy(`${view.omitted} earlier lines not shown.`, `较早的 ${view.omitted} 行未显示。`)}</p>}
  </>;
}

function CommandBody({ view, sessionCwd, copy }: { view: Extract<ToolView, { kind: 'command' }>; sessionCwd?: string; copy: Copy }) {
  const cwd = view.cwd && view.cwd !== sessionCwd ? view.cwd : undefined;
  return <>
    <div className="tool-command"><code>{view.command}</code></div>
    <div className="tool-chip-row">
      {cwd && <span className="chip flat tool-chip" title={cwd}>{copy('cwd', '目录')}: {cwd}</span>}
      {view.background && <span className="chip flat is-accent tool-chip">{copy('Background', '后台')}</span>}
      {view.exitCode !== undefined && view.exitCode !== 0 && <span className="chip flat is-danger tool-chip">{copy('exit', '退出码')} {view.exitCode}</span>}
      {view.actions?.map(action => <span className="chip flat tool-chip" key={action}>{action}</span>)}
    </div>
    {view.output && <OutputBody text={view.output} copy={copy} />}
  </>;
}

function ReadBody({ view, copy, openFile, references }: { view: Extract<ToolView, { kind: 'read' }>; copy: Copy; openFile?: OpenFile; references?: FileReference[] }) {
  // Prefer the structured reference because it can carry the line/column; the
  // generic reference chips are suppressed for read cards so the path shows once.
  const reference = references?.find(value => value.path === view.path);
  const label = reference ? `${reference.path}${reference.line ? `:${reference.line}${reference.column ? `:${reference.column}` : ''}` : ''}` : view.path;
  return <>
    <div className="tool-path"><Icon name="file" />{reference && openFile
      ? <button type="button" className="file-reference-link" onClick={() => openFile(reference)} title={reference.path}>{label}</button>
      : <FileLinkedText text={view.path} openFile={openFile} />}</div>
    <div className="tool-chip-row">
      {view.offset !== undefined && <span className="chip flat tool-chip">{copy('offset', '起始')} {view.offset}</span>}
      {view.limit !== undefined && <span className="chip flat tool-chip">{copy('limit', '行数')} {view.limit}</span>}
      {view.pages !== undefined && <span className="chip flat tool-chip">{copy('pages', '页')} {view.pages}</span>}
    </div>
  </>;
}

function SearchBody({ view, copy }: { view: Extract<ToolView, { kind: 'search' }>; copy: Copy }) {
  return <>
    <div className="tool-search"><code>{view.query}</code></div>
    <div className="tool-chip-row">
      {view.path && <span className="chip flat tool-chip">{view.path}</span>}
      {view.glob && <span className="chip flat tool-chip">{view.glob}</span>}
      {view.matches !== undefined && view.files !== undefined && <span className="chip flat tool-chip">{copy(`${view.matches} matches in ${view.files} files`, `${view.files} 个文件中 ${view.matches} 处匹配`)}</span>}
      {view.flags?.caseInsensitive && <span className="chip flat tool-chip">-i</span>}
      {view.flags?.multiline && <span className="chip flat tool-chip">multiline</span>}
    </div>
    {view.omitted && <p className="tool-card-note">{copy('Some results were not shown.', '部分结果未显示。')}</p>}
  </>;
}

function WebBody({ view, copy }: { view: Extract<ToolView, { kind: 'web' }>; copy: Copy }) {
  const [open, setOpen] = useState(false);
  const label = view.url ?? view.query ?? '';
  return <>
    <div className="tool-path"><Icon name="popout" /><span className="tool-url" title={view.url}>{label}</span></div>
    {view.result && (open
      ? <OutputBody text={view.result} copy={copy} />
      : <button type="button" className="btn btn-sm tool-card-action" onClick={() => setOpen(true)}>{copy('Show result', '显示结果')}</button>)}
  </>;
}

function TodoBody({ view, copy }: { view: Extract<ToolView, { kind: 'todo' }>; copy: Copy }) {
  return <>
    <div className="tool-chip-row"><span className="chip flat tool-chip">{copy(`${view.done}/${view.total} done`, `已完成 ${view.done}/${view.total}`)}</span></div>
    <ul className="tool-todos">
      {view.items.map((item, index) => <li className={`tool-todo is-${item.status}`} key={index}>
        <span className="tool-todo-mark" aria-hidden="true">{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○'}</span>
        <span>{item.text}</span>
      </li>)}
    </ul>
  </>;
}

function ImageBody({ view, copy }: { view: Extract<ToolView, { kind: 'image' }>; copy: Copy }) {
  return <>
    {view.path && <div className="tool-path"><Icon name="file" /><span>{view.path}</span></div>}
    {!!view.images.length && <div className="chat-message-images">{view.images.map((image, index) => <img src={image} key={index} alt={`${copy('Tool image', '工具图片')} ${index + 1}`} loading="lazy" />)}</div>}
    {view.imageStatus && <p className="tool-card-note">{view.imageStatus}</p>}
  </>;
}

function CompactionBody({ view, copy }: { view: Extract<ToolView, { kind: 'compaction' }>; copy: Copy }) {
  const before = view.before ?? 0, after = view.after ?? 0;
  return <>
    <div className="tool-chip-row">
      {(view.before !== undefined || view.after !== undefined) && <span className="chip flat tool-chip">{before.toLocaleString()} → {after.toLocaleString()}</span>}
      {view.trigger && <span className="chip flat tool-chip">{view.trigger}</span>}
    </div>
    {view.before === undefined && view.after === undefined && <p className="tool-card-note">{copy('Context was compacted.', '上下文已压缩。')}</p>}
  </>;
}

function McpBody({ view, copy }: { view: Extract<ToolView, { kind: 'mcp' }>; copy: Copy }) {
  return <>
    {view.server && <div className="tool-chip-row"><span className="chip flat tool-chip">{view.server}</span><span className="chip flat tool-chip">{view.tool}</span></div>}
    {view.args !== undefined && <div className="tool-json-block"><span className="tool-json-label">{copy('Arguments', '参数')}</span><JsonTree value={view.args} copy={copy} /></div>}
    {view.result !== undefined && <div className="tool-json-block"><span className="tool-json-label">{copy('Result', '结果')}</span><JsonTree value={view.result} copy={copy} /></div>}
  </>;
}

function GenericBody({ view, copy }: { view: Extract<ToolView, { kind: 'generic' }>; copy: Copy }) {
  return <>
    {view.args !== undefined && <div className="tool-json-block"><span className="tool-json-label">{copy('Arguments', '参数')}</span><JsonTree value={view.args} copy={copy} /></div>}
    {view.result !== undefined && <div className="tool-json-block"><span className="tool-json-label">{copy('Result', '结果')}</span><JsonTree value={view.result} copy={copy} /></div>}
  </>;
}

/** E2: a `feedback_check` result reads as a count with an optional note list. */
function FeedbackBody({ notes, copy }: { notes: NonNullable<ReturnType<typeof feedbackNotesFromPart>>; copy: Copy }) {
  const [showAll, setShowAll] = useState(false);
  if (!notes.length) return <p className="tool-card-note">{copy('No feedback notes', '没有反馈备注')}</p>;
  return <>
    <div className="tool-chip-row"><span className="chip flat tool-chip">{copy(`${notes.length} feedback ${notes.length === 1 ? 'note' : 'notes'}`, `${notes.length} 条反馈备注`)}</span></div>
    {!showAll && <button type="button" className="btn btn-sm tool-card-action" data-testid="feedback-show-all" onClick={() => setShowAll(true)}>{copy(`Show all (${notes.length})`, `显示全部（${notes.length}）`)}</button>}
    {showAll && <ul className="feedback-note-list">{notes.map(note => <li className="feedback-note-row" key={note.id}>
      <span className={`feedback-note-status is-${note.status}`}>{note.status === 'received' ? copy('Received', '已接收') : copy('Waiting', '等待中')}</span>
      <span className="feedback-note-text">{note.text}</span>
    </li>)}</ul>}
  </>;
}

function CardBody({ part, view, copy, sessionCwd, openFile, openDiff, canOpenDiff, references }: { part: ChatPart; view: ToolView; copy: Copy; sessionCwd?: string; openFile?: OpenFile; openDiff?: (path: string) => void; canOpenDiff?: (path: string) => boolean; references?: FileReference[] }) {
  const feedback = feedbackNotesFromPart(part);
  if (feedback) return <FeedbackBody notes={feedback} copy={copy} />;
  switch (view.kind) {
    case 'edit': return <EditBody view={view} copy={copy} openFile={openFile} openDiff={openDiff} canOpenDiff={canOpenDiff} />;
    case 'command': return <CommandBody view={view} sessionCwd={sessionCwd} copy={copy} />;
    case 'read': return <ReadBody view={view} copy={copy} openFile={openFile} references={references} />;
    case 'search': return <SearchBody view={view} copy={copy} />;
    case 'web': return <WebBody view={view} copy={copy} />;
    case 'todo': return <TodoBody view={view} copy={copy} />;
    case 'skill': return <div className="tool-chip-row"><span className="chip flat tool-chip">{view.name}</span>{view.args && <span className="chip flat tool-chip">{view.args}</span>}</div>;
    case 'image': return <ImageBody view={view} copy={copy} />;
    case 'compaction': return <CompactionBody view={view} copy={copy} />;
    case 'mcp': return <McpBody view={view} copy={copy} />;
    case 'subagent': return null;
    case 'generic': return <GenericBody view={view} copy={copy} />;
  }
}

/** Renders the native part's image attachments below the typed body. */
function CardImages({ part, copy }: { part: ChatPart; copy: Copy }) {
  const data = part.data && typeof part.data === 'object' ? part.data as { images?: unknown } : {};
  const images = Array.isArray(data.images) ? data.images.filter(isChatImage) : [];
  if (!images.length) return null;
  return <div className="chat-message-images">{images.map((image, index) => <img src={image} key={index} alt={`${copy('Tool image', '工具图片')} ${index + 1}`} loading="lazy" />)}</div>;
}

/**
 * One typed tool card inside the shared per-turn drawer. The entry shell is
 * always rendered so identity, ordering and inspection keep working while the
 * drawer is collapsed; the body is built only when `open`.
 */
export function ToolCard({ entry, index, open, active, awaitingApproval, sessionCwd, copy, openFile, openDiff, canOpenDiff }: {
  entry: ToolActivityEntry;
  index: number;
  open: boolean;
  active: boolean;
  awaitingApproval: boolean;
  sessionCwd?: string;
  copy: Copy;
  openFile?: OpenFile;
  openDiff?: (path: string) => void;
  canOpenDiff?: (path: string) => boolean;
}) {
  const view = toolView(entry.part);
  const status = toolStatusLabel(view.status, active, awaitingApproval, copy);
  const body = entry.part.text ?? (entry.part.fileReferences?.length ? partBody(entry.part) : '');
  return <div role="listitem" className={`chat-tool-entry tool-card is-${status.key} is-${view.kind}`} data-tool-id={entry.part.toolId || entry.id} data-tool-kind={view.kind} data-tool-status={view.status}>
    <div className="chat-tool-entry-label tool-card-head">
      <span className="chat-tool-step">{index + 1}</span>
      <Icon name={icons[view.kind]} />
      <strong className="tool-card-title" title={view.title}>{view.title}</strong>
      <span className={`chip tool-card-status ${statusChip[status.key] ?? 'flat'}`}>{status.label}</span>
    </div>
    {open && <div className="tool-card-body">
      <CardBody part={entry.part} view={view} copy={copy} sessionCwd={sessionCwd} openFile={openFile} openDiff={openDiff} canOpenDiff={canOpenDiff} references={entry.part.fileReferences} />
    </div>}
    <CardImages part={entry.part} copy={copy} />
    {view.kind !== 'read' && <FileReferenceChips references={entry.part.fileReferences} visibleText={body} openFile={openFile} />}
  </div>;
}
