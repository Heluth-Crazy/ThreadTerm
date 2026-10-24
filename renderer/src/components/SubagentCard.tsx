import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatItem, FileReference, SubagentInfo } from '@threadterm/protocol';
import { request } from '../bridge';
import { elapsedMs, mergeTranscript, stripInlineMarkdown, subagentStatus, subagentTitle, subagentToolCount, withoutPromptEcho } from '../subagentActivity';
import { groupToolActivity } from '../toolActivity';
import { formatChatDuration } from '../chatPresentation';
import { AgentLoadingMark } from './AgentLoadingMark';
import { AgentIcon, Icon } from './PrototypeIcon';
import { ToolActivity } from './ToolActivity';
import { useVisibleTicker } from '../visibleTicker';
import './subagent-card.css';

export function SubagentCard({ sessionId, info, copy, zh, renderItem, openFile }: {
  sessionId: string;
  info: SubagentInfo;
  copy: (en: string, zh: string) => string;
  zh: boolean;
  renderItem: (item: ChatItem, nested: boolean) => ReactNode;
  openFile?: (reference: FileReference) => void;
}) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [promptClipped, setPromptClipped] = useState(false);
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
  useEffect(() => {
    const state = cache.current, rev = info.rev ?? 0;
    if (!open || info.transcript === 'none' || state.pending) return;
    const changedSource = state.source !== info.transcript;
    if (!changedSource && rev <= state.attemptedRev) return;
    state.pending = true;
    state.source = info.transcript;
    state.attemptedRev = rev;
    const afterRev = changedSource || info.transcript === 'native' ? 0 : state.rev;
    setLoading(true);
    setError(undefined);
    if (changedSource) setItems([]);
    void request('chat.subagent.read', { sessionId, key: info.key, afterRev }).then(result => {
      if (!mounted.current) return;
      state.rev = result.rev;
      setError(result.error);
      setTruncated(result.truncated);
      if (!result.error) setItems(prev => {
        const next = result.source === 'native' || changedSource ? result.items : mergeTranscript(prev, result.items);
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

  const duration = elapsedMs(info);
  const tools = info.toolCount ?? info.usage?.toolUses;
  const tokens = info.usage?.totalTokens;
  const meta = [duration == null ? '' : formatChatDuration(duration, zh), tools == null ? '' : subagentToolCount(tools, copy),
    tokens == null ? '' : `${Intl.NumberFormat(zh ? 'zh-CN' : 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)} ${copy('tokens', '令牌')}`].filter(Boolean);
  const statusLabel = status === 'running' ? copy('Running', '运行中') : status === 'completed' ? copy('Completed', '已完成')
    : status === 'failed' ? copy('Failed', '失败') : status === 'cancelled' ? copy('Stopped', '已停止') : copy('Unknown', '状态未知');
  const title = subagentTitle(info, copy);
  const label = info.description || (info.provider === 'codex' && info.name?.startsWith('/') ? title : info.name || copy('Subagent', '子代理'));
  const transcriptItems = withoutPromptEcho(items, info.prompt);
  return <article className={`v3-chat-message assistant chat-subagent-card is-${status}`} data-subagent-key={info.key}>
    <details open={open} onToggle={event => { if (event.target !== event.currentTarget) return; pin.current = true; setOpen(event.currentTarget.open); }}>
      <summary>
        <span className="chat-subagent-heading"><AgentIcon provider={info.provider} size={16} />
          <span className="chat-subagent-description" title={title}>{label}</span>
          <span className="chat-subagent-status" role="status">{status === 'running' && <AgentLoadingMark provider={info.provider} />}{statusLabel}</span>
          <Icon name="chevR" className="chat-subagent-chevron" />
        </span>
        <span className="chat-subagent-meta">
          <span className="chat-subagent-chip">{info.agentType || copy('Subagent', '子代理')}</span>
          {meta.map((value, index) => <span className="chat-subagent-meta-item" key={index}>{value}</span>)}
        </span>
        {status === 'running' && info.lastActivity && <span className="chat-subagent-current" title={info.lastActivity}>{copy('Now', '当前')}: {info.lastActivity}</span>}
        {status !== 'running' && info.summary && <span className="chat-subagent-preview">{stripInlineMarkdown(info.summary)}</span>}
      </summary>
      {open && <div className="chat-subagent-body">
        {info.prompt && <details className="chat-subagent-task" open={taskOpen} onToggle={event => setTaskOpen(event.currentTarget.open)}><summary>{copy('Task', '任务')}</summary>
          <div ref={prompt} className={`chat-subagent-prompt${more ? ' is-expanded' : ''}`}>{info.prompt}</div>
          {(promptClipped || more) && <button type="button" className="btn" onClick={() => setMore(value => !value)}>{more ? copy('Show less', '收起') : copy('Show more', '展开全文')}</button>}
        </details>}
        {info.transcript === 'none' && <p className="chat-subagent-note">{copy('This agent only reports a final summary for subagents.', '此代理仅提供子代理的最终摘要。')}</p>}
        {info.transcript === 'native' && <p className="chat-subagent-note">{copy('Loaded from', '来自')} {info.provider} {copy('session files', '会话文件')}</p>}
        {(info.truncated || truncated) && <p className="chat-subagent-note">{copy('Earlier steps were trimmed', '较早的步骤已被裁剪')}</p>}
        {loading && <p className="chat-subagent-note" role="status">{copy('Loading transcript…', '正在加载记录…')}</p>}
        {error && <p className="chat-subagent-error" role="alert">{error}</p>}
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
