import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatItem, CodeReviewFinding, FileReference, Session, SubagentInfo } from '@threadterm/protocol';
import { request } from '../bridge';
import {
  appendComposerText,
  codeReviewProgressLine,
  codeReviewResultLine,
  composeFixMessage,
  findingLocation,
  groupCodeReviewFindings,
} from '../codeReview';
import { elapsedMs, mergeTranscript, stripInlineMarkdown, subagentStatus, subagentTitle, subagentToolCount, withoutPromptEcho } from '../subagentActivity';
import { groupToolActivity } from '../toolActivity';
import { formatChatDuration } from '../chatPresentation';
import { AgentLoadingMark } from './AgentLoadingMark';
import { AgentTile, Icon } from './PrototypeIcon';
import { ToolActivity } from './ToolActivity';
import { useVisibleTicker } from '../visibleTicker';
import './subagent-card.css';

export function SubagentCard({ sessionId, info, copy, zh, renderItem, openFile, sessions = [], onOpenSession, onInsertFix, onCancelReview, composerText = '' }: {
  sessionId: string;
  info: SubagentInfo;
  copy: (en: string, zh: string) => string;
  zh: boolean;
  renderItem: (item: ChatItem, nested: boolean) => ReactNode;
  openFile?: (reference: FileReference) => void;
  sessions?: readonly Session[];
  onOpenSession?: (sessionId: string) => void;
  onInsertFix?: (text: string) => void;
  onCancelReview?: (reviewId: string) => void | Promise<void>;
  composerText?: string;
}) {
  const review = info.review;
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [promptClipped, setPromptClipped] = useState(false);
  const [reviewerMenu, setReviewerMenu] = useState(false);
  const [busyCancel, setBusyCancel] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [, tick] = useState(0);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const [readVersion, setReadVersion] = useState(0);
  const cache = useRef<{ source?: string; attemptedRev: number; rev: number; pending: boolean }>({ attemptedRev: -1, rev: 0, pending: false });
  const mounted = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  const prompt = useRef<HTMLDivElement>(null);
  const pin = useRef(true);
  const status = subagentStatus(info);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Elapsed time is only shown while the card is expanded; collapsed and
  // finished cards keep no timer, and a hidden window stops it too.
  useVisibleTicker(() => tick(value => value + 1), open && status === 'running');

  // Serialize reads and remember attempts, including errors. A render/timer never
  // retries a read; only opening an unread card, a source change, or a newer rev does.
  // Native and Code Review ('session') transcripts are full replacements.
  useEffect(() => {
    const state = cache.current, rev = info.rev ?? 0;
    if (!open || info.transcript === 'none' || state.pending) return;
    const changedSource = state.source !== info.transcript;
    if (!changedSource && rev <= state.attemptedRev) return;
    state.pending = true;
    state.source = info.transcript;
    state.attemptedRev = rev;
    const fullReplace = changedSource || info.transcript === 'native' || info.transcript === 'session';
    const afterRev = fullReplace ? 0 : state.rev;
    setLoading(true);
    setError(undefined);
    if (changedSource) setItems([]);
    void request('chat.subagent.read', { sessionId, key: info.key, afterRev }).then(result => {
      if (!mounted.current) return;
      state.rev = result.rev;
      setError(result.error);
      setTruncated(result.truncated);
      if (!result.error) setItems(prev => {
        const next = result.source === 'native' || result.source === 'session' || changedSource ? result.items : mergeTranscript(prev, result.items);
        return result.truncated ? next.slice(-500) : next;
      });
    }).catch(reason => {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      state.pending = false;
      if (mounted.current) { setLoading(false); setReadVersion(value => value + 1); }
    });
  }, [open, info.rev, info.transcript, sessionId, info.key, readVersion]);
  useLayoutEffect(() => {
    if (open && pin.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [open, items]);
  useLayoutEffect(() => {
    if (open && taskOpen && !more && prompt.current) setPromptClipped(prompt.current.scrollHeight > prompt.current.clientHeight);
  }, [open, taskOpen, more, info.prompt]);

  const findings = review?.findings ?? [];
  const findingIds = findings.map(finding => finding.id).join('\0');
  useEffect(() => {
    setSelected(Object.fromEntries(findings.map(finding => [finding.id, true])));
  }, [review?.reviewId, findingIds]);

  const duration = elapsedMs(info);
  const tools = info.toolCount ?? info.usage?.toolUses;
  const tokens = info.usage?.totalTokens;
  const meta = [duration == null ? '' : formatChatDuration(duration, zh), tools == null ? '' : subagentToolCount(tools, copy),
    tokens == null ? '' : `${Intl.NumberFormat(zh ? 'zh-CN' : 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)} ${copy('tokens', '令牌')}`].filter(Boolean);
  const statusLabel = status === 'running' ? copy('Running', '运行中') : status === 'completed' ? copy('Completed', '已完成')
    : status === 'failed' ? copy('Failed', '失败') : status === 'cancelled' ? (review ? copy('Cancelled', '已取消') : copy('Stopped', '已停止')) : copy('Unknown', '状态未知');
  const title = subagentTitle(info, copy);
  const label = review
    ? copy('Code review', '代码审查')
    : info.description || (info.provider === 'codex' && info.name?.startsWith('/') ? title : info.name || copy('Subagent', '子代理'));
  const transcriptItems = withoutPromptEcho(items, info.prompt);
  const reviewers = useMemo(() => (review?.reviewerSessionIds ?? [])
    .map(id => sessions.find(session => session.id === id))
    .filter((session): session is Session => Boolean(session)), [review?.reviewerSessionIds, sessions]);
  const awaitingApproval = reviewers.some(session => session.activity?.state === 'awaiting_approval');
  const progress = review && status === 'running'
    ? codeReviewProgressLine(review, copy, { awaitingApproval })
    : undefined;
  const groups = groupCodeReviewFindings(findings);
  const selectedFindings = findings.filter(finding => selected[finding.id] !== false);

  async function cancelReview() {
    if (!review || busyCancel || !onCancelReview) return;
    setBusyCancel(true);
    try {
      await onCancelReview(review.reviewId);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setBusyCancel(false);
    }
  }

  function openFinding(finding: CodeReviewFinding) {
    if (!finding.path || !openFile) return;
    openFile({ path: finding.path, line: finding.line });
  }

  function askFix() {
    if (!onInsertFix || !selectedFindings.length) return;
    onInsertFix(appendComposerText(composerText, composeFixMessage(selectedFindings)));
  }

  async function copyFindings() {
    if (!selectedFindings.length) return;
    try {
      await navigator.clipboard.writeText(composeFixMessage(selectedFindings));
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const depthLabel = review?.depth === 'quick' ? copy('Quick', '快速')
    : review?.depth === 'thorough' ? copy('Thorough', '彻底')
    : copy('Standard', '标准');

  return <article className={`v3-chat-message assistant chat-subagent-card is-${status}${review ? ' is-code-review' : ''}`} data-subagent-key={info.key} data-review-id={review?.reviewId}>
    <details open={open} onToggle={event => { if (event.target !== event.currentTarget) return; pin.current = true; setOpen(event.currentTarget.open); }}>
      <summary>
        <span className="chat-subagent-heading"><AgentTile provider={info.provider} size={16} />
          <span className="chat-subagent-description" title={review ? `${label}${review.model ? ` · ${review.model}` : ''}` : title}>{label}</span>
          <span className="chat-subagent-status" role="status">{status === 'running' && <AgentLoadingMark provider={info.provider} />}{statusLabel}</span>
          <Icon name="chevR" className="chat-subagent-chevron" />
        </span>
        <span className="chat-subagent-meta">
          {review ? <>
            {review.model && <span className="chat-subagent-chip">{review.model}</span>}
            <span className="chat-subagent-chip">{depthLabel}</span>
            <span className="chat-subagent-chip" title={review.scopeLabel}>{review.scopeLabel}</span>
          </> : <span className="chat-subagent-chip">{info.agentType || copy('Subagent', '子代理')}</span>}
          {meta.map((value, index) => <span className="chat-subagent-meta-item" key={index}>{value}</span>)}
        </span>
        {status === 'running' && (progress || info.lastActivity) && <span className="chat-subagent-current" title={progress || info.lastActivity}>
          {progress || `${copy('Now', '当前')}: ${info.lastActivity}`}
          {progress && info.lastActivity ? ` · ${info.lastActivity}` : ''}
        </span>}
        {status !== 'running' && !review && info.summary && <span className="chat-subagent-preview">{stripInlineMarkdown(info.summary)}</span>}
        {status === 'failed' && review && info.summary && <span className="chat-subagent-preview">{stripInlineMarkdown(info.summary)}</span>}
        {status === 'cancelled' && review && <span className="chat-subagent-preview">{copy('Cancelled', '已取消')}</span>}
        {status === 'completed' && review && !findings.length && <span className="chat-subagent-preview">{copy('No issues found', '未发现问题')}</span>}
        {status === 'completed' && review && findings.length > 0 && <span className="chat-subagent-preview">{codeReviewResultLine(findings, copy)}</span>}
      </summary>
      {open && <div className="chat-subagent-body">
        {review && <div className="chat-review-actions">
          {status === 'running' && onCancelReview && <button type="button" className="btn" data-testid="code-review-stop" disabled={busyCancel} onClick={() => void cancelReview()}>{copy('Stop', '停止')}</button>}
          {reviewers.length === 1 && onOpenSession && <button type="button" className="btn" data-testid="code-review-open-reviewer" onClick={() => onOpenSession(reviewers[0]!.id)}>{copy('Open reviewer chat', '打开审查会话')}</button>}
          {reviewers.length > 1 && onOpenSession && <div className="chat-review-reviewer-menu">
            <button type="button" className="btn" aria-expanded={reviewerMenu} data-testid="code-review-open-reviewers" onClick={() => setReviewerMenu(value => !value)}>{copy('Open reviewer chat', '打开审查会话')}</button>
            {reviewerMenu && <div className="menu chat-review-menu" role="menu">
              {reviewers.map(session => <button type="button" role="menuitem" className="menu-item" key={session.id} onClick={() => { setReviewerMenu(false); onOpenSession(session.id); }}>
                {session.codeReview?.role === 'verifier' ? copy('Verifier', '核实') : (session.codeReview?.lens || session.title)}
              </button>)}
            </div>}
          </div>}
        </div>}

        {!review && info.prompt && <details className="chat-subagent-task" open={taskOpen} onToggle={event => setTaskOpen(event.currentTarget.open)}><summary>{copy('Task', '任务')}</summary>
          <div ref={prompt} className={`chat-subagent-prompt${more ? ' is-expanded' : ''}`}>{info.prompt}</div>
          {(promptClipped || more) && <button type="button" className="btn" onClick={() => setMore(value => !value)}>{more ? copy('Show less', '收起') : copy('Show more', '展开全文')}</button>}
        </details>}
        {info.transcript === 'none' && <p className="chat-subagent-note">{copy('This agent only reports a final summary for subagents.', '此代理仅提供子代理的最终摘要。')}</p>}
        {info.transcript === 'native' && <p className="chat-subagent-note">{copy('Loaded from', '来自')} {info.provider} {copy('session files', '会话文件')}</p>}
        {(info.truncated || truncated) && <p className="chat-subagent-note">{copy('Earlier steps were trimmed', '较早的步骤已被裁剪')}</p>}
        {loading && <p className="chat-subagent-note" role="status">{copy('Loading transcript…', '正在加载记录…')}</p>}
        {error && <p className="chat-subagent-error" role="alert">{error}</p>}

        {review && (status === 'completed' || status === 'failed' || status === 'cancelled') && <div className="chat-review-result" data-testid="code-review-result">
          {status === 'cancelled' && <p className="chat-subagent-note">{copy('Cancelled', '已取消')}</p>}
          {status === 'failed' && info.summary && <p className="chat-subagent-error" role="alert">{info.summary}</p>}
          {(review.warnings ?? []).map((warning, index) => <p className="chat-subagent-note" key={`warn-${index}`}>{warning}</p>)}
          {status === 'completed' && !findings.length && <p className="chat-subagent-note" data-testid="code-review-empty">{copy('No issues found', '未发现问题')}</p>}
          {status === 'completed' && (review.rejected ?? 0) > 0 && <p className="chat-subagent-note">{copy(`${review.rejected} rejected on verification`, `核实中驳回 ${review.rejected} 条`)}</p>}
          {groups.map(group => <section className="chat-review-group" key={group.verdict} data-verdict={group.verdict}>
            <h3>{group.verdict === 'confirmed' ? copy('Confirmed', '已确认') : group.verdict === 'plausible' ? copy('Plausible', '可能成立') : copy('Unverified', '未核实')}</h3>
            {group.items.map(finding => {
              const location = findingLocation(finding);
              return <article className="chat-review-finding" key={finding.id} data-finding-id={finding.id}>
                <label className="chat-review-finding-head">
                  <input type="checkbox" checked={selected[finding.id] !== false} onChange={event => setSelected(current => ({ ...current, [finding.id]: event.target.checked }))} />
                  <span className={`chat-review-severity is-${finding.severity}`}>{finding.severity}</span>
                  <span className="chat-review-title">{finding.title}</span>
                </label>
                {location && <button type="button" className="chat-review-location" onClick={() => openFinding(finding)}>{location}</button>}
                <p className="chat-review-body">{finding.body}</p>
                {finding.failureScenario && <details className="chat-review-scenario"><summary>{copy('Failure scenario', '失败场景')}</summary><p>{finding.failureScenario}</p></details>}
              </article>;
            })}
          </section>)}
          {findings.length > 0 && <div className="chat-review-fix-actions">
            <button type="button" className="btn btn-primary" data-testid="code-review-ask-fix" disabled={!selectedFindings.length || !onInsertFix} onClick={askFix}>{copy('Ask this chat to fix', '让此聊天修复')}</button>
            <button type="button" className="btn" data-testid="code-review-copy" disabled={!selectedFindings.length} onClick={() => void copyFindings()}>{copy('Copy', '复制')}</button>
          </div>}
        </div>}

        <div className="chat-subagent-transcript" ref={transcript} onScroll={event => {
          const node = event.currentTarget; pin.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        }}>
          {groupToolActivity(transcriptItems).map(entry => entry.type === 'tools'
            ? <ToolActivity key={entry.id} entries={entry.tools} active={status === 'running'} provider={info.provider} copy={copy} openFile={openFile} onInspect={() => { pin.current = false; }} />
            : <Fragment key={entry.id}>{renderItem(entry.item, true)}</Fragment>)}
          {!loading && !error && !transcriptItems.length && info.transcript !== 'none' && <p className="chat-subagent-note">{copy('No steps recorded yet.', '尚未记录步骤。')}</p>}
        </div>
      </div>}
    </details>
  </article>;
}
