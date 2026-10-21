import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatItem, ChatPart, ReviewFile, Session, SubagentTranscriptRead } from '@threadterm/protocol';
import type { TaskFlowChatTarget, TaskMapLane, TaskMapNode } from '../taskMapTypes';
import { taskMapStatusLabel } from '../taskMapView';
import { request } from '../bridge';
import { openAndRevealInChat } from '../chatFlowSync';
import { formatChatDuration } from '../chatPresentation';
import { planDataOf, planEntryLabel, planProgress } from '../chatPlan';
import { approvalData, choiceLabel } from '../chatApproval';
import { delegationStateLabel, delegateOutcomePreview } from '../delegation';
import { providerLabel } from '../chatConnection';
import { elapsedMs as subagentElapsedMs, subagentToolCount } from '../subagentActivity';
import { ChatMarkdown } from './ChatMarkdownExtras';
import { renderCodexMarkdown } from './ChatView';
import { ToolCard } from './ToolCards';
import { AgentIcon } from './PrototypeIcon';

type Copy = (en: string, zh: string) => string;
type DetailState<T> = { value?: T; loading?: boolean; error?: string };
const INSPECTOR_CACHE_LIMIT = 20;

/** Mutable, per-tab deferred-detail storage. The owning map keeps this in a ref. */
export interface TaskMapInspectorCache {
  reviews: Map<string, DetailState<readonly ReviewFile[]>>;
  transcripts: Map<string, DetailState<SubagentTranscriptRead>>;
}

export function createTaskMapInspectorCache(): TaskMapInspectorCache {
  return { reviews: new Map(), transcripts: new Map() };
}

export interface TaskMapDetailsProps {
  node: TaskMapNode;
  lane?: TaskMapLane;
  sessions: readonly Session[];
  items: ReadonlyMap<string, readonly ChatItem[]>;
  zh: boolean;
  visible: boolean;
  target?: TaskFlowChatTarget;
  durationMs?: number;
  onOpenSession?: (sessionId: string) => void;
  onOpenReview?: (target: { sessionId: string; checkpointId: string; toCheckpointId?: string; path: string }) => void;
  onOpenFile?: (target: { sessionId: string; path: string }) => void;
  cache?: TaskMapInspectorCache;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const copyFor = (zh: boolean): Copy => (en, chinese) => zh ? chinese : en;

function cacheSet<T>(cache: Map<string, DetailState<T>>, key: string, value: DetailState<T>) {
  cache.delete(key); cache.set(key, value);
  while (cache.size > INSPECTOR_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

function nodeParts(node: TaskMapNode, items: ReadonlyMap<string, readonly ChatItem[]>): { item: ChatItem; part: ChatPart; partIndex: number }[] {
  const rows = items.get(node.sessionId ?? '') ?? [];
  const byId = new Map<string, ChatItem>();
  for (const item of rows) byId.set(item.id, item);
  return node.parts.flatMap(reference => {
    const item = byId.get(reference.itemId), part = item?.parts[reference.partIndex];
    return item && part ? [{ item, part, partIndex: reference.partIndex }] : [];
  });
}

function DetailError({ error, retry, copy }: { error?: string; retry: () => void; copy: Copy }) {
  return <div className="surface-error"><span>{error}</span><div className="task-map-inspector-actions"><button type="button" className="btn btn-sm" onClick={retry}>{copy('Retry', '重试')}</button></div></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <section className="task-map-inspector-field"><strong>{label}</strong>{children}</section>;
}

export function TaskMapDetails({ node, lane, sessions, items, zh, visible, target, durationMs, onOpenSession, onOpenReview, onOpenFile, cache }: TaskMapDetailsProps) {
  const copy = copyFor(zh), [revision, setRevision] = useState(0);
  const fallbackCache = useRef(createTaskMapInspectorCache()), mounted = useRef(true), visibleRef = useRef(visible);
  const detailCache = cache ?? fallbackCache.current;
  const parts = useMemo(() => nodeParts(node, items), [node, items]);
  const deferredKey = node.kind === 'files' && node.review ? `${node.sessionId}:${node.review.from}:${node.review.to}` : undefined;
  const transcriptKey = node.kind === 'subagent' && node.subagent && node.sessionId ? `${node.sessionId}:${node.subagent.key}` : undefined;
  const reviewState = deferredKey ? detailCache.reviews.get(deferredKey) : undefined;
  const transcriptState = transcriptKey ? detailCache.transcripts.get(transcriptKey) : undefined;
  const refresh = () => { if (mounted.current && visibleRef.current) setRevision(value => value + 1); };
  void revision;

  useEffect(() => { visibleRef.current = visible; if (visible) refresh(); }, [visible]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const loadReview = () => {
    if (!visible || !deferredKey || !node.sessionId || !node.review) return;
    const current = detailCache.reviews.get(deferredKey);
    if (current?.loading || current?.value) return;
    const pending: DetailState<readonly ReviewFile[]> = { loading: true };
    cacheSet(detailCache.reviews, deferredKey, pending); refresh();
    void request('review.changes', { sessionId: node.sessionId, from: node.review.from, to: node.review.to })
      .then(result => { if (detailCache.reviews.get(deferredKey) !== pending) return; cacheSet(detailCache.reviews, deferredKey, { value: result.files }); refresh(); })
      .catch(error => { if (detailCache.reviews.get(deferredKey) !== pending) return; cacheSet(detailCache.reviews, deferredKey, { error: String(error) }); refresh(); });
  };
  const loadTranscript = () => {
    if (!visible || !transcriptKey || !node.sessionId || !node.subagent) return;
    const current = detailCache.transcripts.get(transcriptKey);
    if (current?.loading || current?.value) return;
    const pending: DetailState<SubagentTranscriptRead> = { loading: true };
    cacheSet(detailCache.transcripts, transcriptKey, pending); refresh();
    void request('chat.subagent.read', { sessionId: node.sessionId, key: node.subagent.key })
      .then(result => { if (detailCache.transcripts.get(transcriptKey) !== pending) return; cacheSet(detailCache.transcripts, transcriptKey, result.error ? { error: result.error } : { value: result }); refresh(); })
      .catch(error => { if (detailCache.transcripts.get(transcriptKey) !== pending) return; cacheSet(detailCache.transcripts, transcriptKey, { error: String(error) }); refresh(); });
  };
  useEffect(() => { if (visible && node.kind === 'files' && node.review) loadReview(); }, [visible, node.id, deferredKey]);

  const at = node.at !== undefined ? new Date(node.at).toLocaleTimeString(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : undefined;
  const duration = durationMs ?? parts.find(value => value.item.elapsedMs !== undefined)?.item.elapsedMs;
  const openFile = (path: string) => node.sessionId && onOpenFile?.({ sessionId: node.sessionId, path });
  const toolParts = parts.filter(value => value.part.type === 'tool');
  const promptText = parts.filter(value => value.part.type === 'text').map(value => value.part.text).filter(Boolean).join('\n');
  const replyText = parts.filter(value => value.part.type === 'text').map(value => value.part.text).filter((value): value is string => Boolean(value)).join('\n\n');
  const inspectorLane = node.kind === 'subagent' && node.subagent
    ? <><AgentIcon provider={node.subagent.provider} size={14} /> {providerLabel(node.subagent.provider)}</>
    : <>{lane?.provider && <AgentIcon provider={lane.provider} size={14} />} {lane?.title}</>;

  return <aside className="task-map-details" aria-label={copy('Step details', '步骤详情')}>
    <div className="task-map-details-meta">
      <span className="task-map-inspector-lane">{inspectorLane}</span>
      <span className={`chip st-${node.status === 'done' ? 'ended' : node.status === 'waiting' ? 'needs' : node.status}`}>{taskMapStatusLabel(node.status, copy)}</span>
      {(at || duration !== undefined) && <small>{[at, duration !== undefined ? formatChatDuration(duration, zh) : undefined].filter(Boolean).join(' · ')}</small>}
    </div>
    <div className="task-map-inspector-actions">
      {target && <button type="button" className="btn btn-sm" onClick={() => openAndRevealInChat(target, onOpenSession)}>{copy('Show in Chat', '在对话中显示')}</button>}
      {node.kind === 'delegate' && node.childSessionId && <button type="button" className="btn btn-sm" onClick={() => onOpenSession?.(node.childSessionId!)}>{copy('Open session', '打开会话')}</button>}
      {node.kind === 'subagent' && <button type="button" className="btn btn-sm" onClick={loadTranscript} disabled={!visible || Boolean(transcriptState?.loading)}>{transcriptState?.loading ? copy('Loading…', '正在加载…') : copy('Load transcript', '加载记录')}</button>}
      {node.kind === 'document' && node.path && <button type="button" className="btn btn-sm" onClick={() => openFile(node.path!)}>{copy('Open', '打开')}</button>}
    </div>
    <div className="task-map-inspector-body">
      {node.kind === 'tools' && <div className="chat-tool-entries" role="list">{toolParts.map((value, index) => <ToolCard key={`${value.item.id}:${value.partIndex}`} entry={{ id: `${value.item.id}:${value.partIndex}`, itemId: value.item.id, part: value.part }} index={index} open active={node.status === 'running'} awaitingApproval={node.status === 'waiting'} copy={copy} openFile={reference => openFile(reference.path)} />)}</div>}
      {node.kind === 'prompt' && <pre className="task-map-inspector-pre">{promptText}</pre>}
      {node.kind === 'reply' && replyText && <ChatMarkdown sanitizedHtml={renderCodexMarkdown(replyText, zh)} copy={copy} />}
      {node.kind === 'plan' && <PlanDetails parts={parts} copy={copy} />}
      {node.kind === 'delegate' && <DelegateDetails key={node.id} node={node} sessions={sessions} items={items} copy={copy} zh={zh} />}
      {node.kind === 'subagent' && node.subagent && <SubagentDetails info={node.subagent} transcript={transcriptState} copy={copy} zh={zh} openFile={openFile} retry={() => { if (transcriptKey) detailCache.transcripts.delete(transcriptKey); loadTranscript(); }} />}
      {(node.kind === 'approval' || node.kind === 'question') && <ApprovalDetails parts={parts} copy={copy} />}
      {node.kind === 'error' && <pre className="task-map-inspector-pre">{parts.map(value => value.part.text || text(record(value.part.data).message)).filter(Boolean).join('\n') || node.detail || node.label}</pre>}
      {node.kind === 'files' && <FilesDetails node={node} review={reviewState} copy={copy} openFile={openFile} openReview={onOpenReview} retry={() => { if (deferredKey) detailCache.reviews.delete(deferredKey); loadReview(); }} />}
      {node.kind === 'document' && <><Field label={copy('Document', '文档')}><p>{node.label}</p><code>{node.path}</code></Field></>}
    </div>
  </aside>;
}

function DelegateDetails({ node, sessions, items, copy, zh }: { node: TaskMapNode; sessions: readonly Session[]; items: ReadonlyMap<string, readonly ChatItem[]>; copy: Copy; zh: boolean }) {
  const [all, setAll] = useState(false), child = sessions.find(session => session.id === node.childSessionId);
  if (!child) return <p className="note">{copy('Delegate details are unavailable.', '委派详情不可用。')}</p>;
  const prompt = (items.get(child.id) ?? []).find(item => item.role === 'user')?.parts.map(part => part.text ?? '').join('\n');
  const outcome = delegateOutcomePreview(items.get(child.id) ?? [], child.delegation?.state === 'failed');
  return <>
    <Field label={copy('Delegate', '委派代理')}><p><AgentIcon provider={child.provider} size={16} /> {providerLabel(child.provider)} · {delegationStateLabel(child.delegation?.state ?? 'running', zh)}</p><p>{copy('Workspace', '工作区')}: {child.delegation?.workspace === 'worktree' ? copy('Worktree', '工作树') : copy('Shared', '共享')}{child.delegation?.branch && ` · ${child.delegation.branch}`}</p></Field>
    {prompt && <Field label={copy('Task', '任务')}><pre className={`task-map-inspector-pre task-map-inspector-clamped${all ? ' is-expanded' : ''}`}>{prompt}</pre><button type="button" className="btn btn-sm" onClick={() => setAll(value => !value)}>{all ? copy('Show less', '收起') : copy('Show all', '显示全部')}</button></Field>}
    {outcome && <Field label={copy('Outcome', '结果')}><p>{outcome}</p></Field>}
  </>;
}

function PlanDetails({ parts, copy }: { parts: readonly { item: ChatItem; part: ChatPart; partIndex: number }[]; copy: Copy }) {
  const latest = [...parts].reverse().map(value => ({ value, data: planDataOf(value.part) })).find(value => value.data);
  if (!latest?.data) return null;
  const progress = planProgress(latest.data.entries);
  return <Field label={copy(`Plan ${progress.done}/${progress.total}`, `计划 ${progress.done}/${progress.total}`)}>{latest.data.explanation && <p>{latest.data.explanation}</p>}<ul>{latest.data.entries.map((entry, index) => <li key={index}>{entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '◐' : '○'} {planEntryLabel(entry, copy)}</li>)}</ul></Field>;
}

function SubagentDetails({ info, transcript, copy, zh, openFile, retry }: { info: NonNullable<TaskMapNode['subagent']>; transcript?: DetailState<SubagentTranscriptRead>; copy: Copy; zh: boolean; openFile: (path: string) => void; retry: () => void }) {
  const rows = transcript?.value?.items.slice(0, 200) ?? [];
  const duration = subagentElapsedMs(info), tools = info.toolCount ?? info.usage?.toolUses;
  const status = info.status === 'unknown' ? copy('Unknown', '未知') : taskMapStatusLabel(info.status === 'completed' ? 'done' : info.status, copy);
  const task = info.prompt ?? info.description;
  return <>
    <dl className="task-map-inspector-fields">
      {info.agentType && <><dt>{copy('Type', '类型')}</dt><dd>{info.agentType}</dd></>}
      {status && <><dt>{copy('Status', '状态')}</dt><dd>{status}</dd></>}
      {tools !== undefined && <><dt>{copy('Tools', '工具')}</dt><dd>{subagentToolCount(tools, copy)}</dd></>}
      {duration !== undefined && <><dt>{copy('Duration', '时长')}</dt><dd>{formatChatDuration(duration, zh)}</dd></>}
      {task && <><dt>{copy('Task', '任务')}</dt><dd><pre className="task-map-inspector-pre">{task}</pre></dd></>}
      {info.summary && <><dt>{copy('Result', '结果')}</dt><dd>{info.summary}</dd></>}
    </dl>
    {transcript?.error && <DetailError error={transcript.error} retry={retry} copy={copy} />}
    {transcript?.value && <Field label={copy('Transcript', '记录')}><div className="chat-tool-entries" role="list">{rows.flatMap(item => item.parts.map((part, index) => part.type === 'tool' ? <ToolCard key={`${item.id}:${index}`} entry={{ id: `${item.id}:${index}`, itemId: item.id, part }} index={index} open active={part.status === 'running'} awaitingApproval={false} copy={copy} openFile={reference => openFile(reference.path)} /> : part.text ? <pre className="task-map-inspector-pre" key={`${item.id}:${index}`}>{part.text}</pre> : null))}</div>{(transcript.value.truncated || transcript.value.items.length > rows.length) && <p className="note">{copy('Open the Chat to see everything.', '打开对话以查看全部内容。')}</p>}</Field>}
  </>;
}

function ApprovalDetails({ parts, copy }: { parts: ReadonlyArray<{ item: ChatItem; part: ChatPart }>; copy: Copy }) {
  const part = parts.find(value => value.part.type === 'approval')?.part ?? parts[0]?.part;
  const data = part && approvalData(part), raw = record(part?.data);
  const input = record(raw.input ?? raw.arguments), form = record(raw.form);
  const question = text(raw.question) ?? text(input.question) ?? text(raw.prompt) ?? text(input.prompt) ?? text(form.message) ?? part?.text;
  const questions = raw.questions ?? input.questions ?? form.questions ?? form.fields;
  const questionRows = Array.isArray(questions) ? questions : [];
  const resultText = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
    return undefined;
  };
  const rawAnswer = resultText(raw.answerSummary) ?? text(raw.answer) ?? text(raw.resolvedChoice) ?? resultText(raw.result) ?? text(raw.outcome) ?? data?.planOutcome;
  const answer = rawAnswer === 'approved' ? copy('Approved', '已批准') : rawAnswer === 'changes_requested' ? copy('Changes requested', '已要求修改') : rawAnswer === 'abandoned' ? copy('Abandoned', '已放弃') : rawAnswer;
  const status = part?.status === 'pending' ? taskMapStatusLabel('waiting', copy) : part?.status === 'failed' ? taskMapStatusLabel('failed', copy) : answer ? copy('Resolved', '已解决') : undefined;
  const rawChoices = raw.choices ?? input.choices ?? input.options;
  const choices = Array.isArray(rawChoices) ? rawChoices : [];
  const renderOption = (value: unknown, index: number) => <li key={index}>{typeof value === 'string' ? value : text(record(value).label) ?? text(record(value).value)}{text(record(value).description) && ` · ${text(record(value).description)}`}</li>;
  return <Field label={data?.title ?? (data?.interaction === 'userInput' || part?.type === 'tool' ? copy('Question', '问题') : copy('Approval', '批准'))}>
    {status && <p>{status}</p>}{question && <pre className="task-map-inspector-pre">{question}</pre>}
    {questionRows.map((value, index) => { const row = record(value); return <div key={index}><p>{typeof value === 'string' ? value : text(row.question) ?? text(row.title) ?? text(row.label) ?? text(row.prompt)}</p>{Array.isArray(row.options) && <ul>{row.options.map(renderOption)}</ul>}</div>; })}
    {data?.choices.length ? <ul>{data.choices.map(choice => <li key={choice.choiceId}>{choiceLabel(choice, copy)}{choice.description && ` · ${choice.description}`}</li>)}</ul> : choices.length ? <ul>{choices.map(renderOption)}</ul> : null}
    {answer && <Field label={copy('Outcome', '结果')}><pre className="task-map-inspector-pre">{answer}{data?.feedback && ` · ${data.feedback}`}</pre></Field>}
  </Field>;
}

function FilesDetails({ node, review, copy, openFile, openReview, retry }: { node: TaskMapNode; review?: DetailState<readonly ReviewFile[]>; copy: Copy; openFile: (path: string) => void; openReview?: TaskMapDetailsProps['onOpenReview']; retry: () => void }) {
  const files: readonly ReviewFile[] = review?.value ?? node.files?.map<ReviewFile>(path => ({ path, status: 'M' })) ?? [];
  const counts = (file: ReviewFile) => file.binary ? copy('Binary', '二进制') : file.added !== undefined || file.removed !== undefined ? [file.added !== undefined && `+${file.added}`, file.removed !== undefined && `−${file.removed}`].filter(Boolean).join(' ') : undefined;
  return <>{review?.loading && <p className="note">{copy('Loading changed files…', '正在加载修改的文件…')}</p>}{review?.error && <DetailError error={review.error} retry={retry} copy={copy} />}{files.map(file => <div className="task-map-inspector-file" key={file.path}><code>{file.path}</code>{counts(file) && <span>{counts(file)}</span>}<div className="task-map-inspector-actions">{node.review && openReview && <button type="button" className="btn btn-sm" onClick={() => openReview({ sessionId: node.sessionId!, checkpointId: node.review!.from, toCheckpointId: node.review!.to, path: file.path })}>{copy('Open diff', '查看差异')}</button>}{file.status !== 'D' && <button type="button" className="btn btn-sm" onClick={() => openFile(file.path)}>{copy('Open file', '打开文件')}</button>}</div></div>)}</>;
}

export default TaskMapDetails;
