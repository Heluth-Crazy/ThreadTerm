import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { ChatQueue as ChatQueueState, ChatQueueItem } from '@threadterm/protocol';
import { operationId, request, subscribeEvents } from '../bridge';
import { queueItemSummary, queuePauseReason } from '../chatQueue';
import './chat-queue.css';

type Props = {
  sessionId: string;
  queue: ChatQueueState | undefined;
  leaseEpoch: number | undefined;
  writable: boolean;
  idle: boolean;
  onChange: (queue: ChatQueueState) => void;
  onIssue: (message: string) => void;
  zh: boolean;
};

export function ChatQueue({ sessionId, queue, leaseEpoch, writable, idle, onChange, onIssue, zh }: Props) {
  const [editing, setEditing] = useState<ChatQueueItem | undefined>();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string>();
  const editRef = useRef<HTMLTextAreaElement>(null);
  const currentSession = useRef(sessionId); currentSession.current = sessionId;
  const lifecycleGeneration = useRef(0);
  const refreshSequence = useRef(0);
  const copy = (en: string, cn: string) => zh ? cn : en;

  useEffect(() => {
    let disposed = false;
    const generation = ++lifecycleGeneration.current;
    setBusy(undefined); setEditing(undefined);
    const reload = () => {
      const sequence = ++refreshSequence.current;
      return request('chat.queue.read', { sessionId }).then(next => {
        if (!disposed && lifecycleGeneration.current === generation && currentSession.current === sessionId && sequence === refreshSequence.current) onChange(next);
      }).catch(error => {
        if (!disposed && lifecycleGeneration.current === generation && currentSession.current === sessionId && sequence === refreshSequence.current) onIssue(String(error));
      });
    };
    void reload();
    const unsubscribe = subscribeEvents(event => {
      const data = event.data as { kind?: unknown; sessionId?: unknown; state?: unknown } | null;
      if (event.event === 'runtime.transport') {
        if (data?.state === 'disconnected' || data?.state === 'incompatible') refreshSequence.current += 1;
        if (data?.state === 'reconnected') void reload();
      }
      if (event.event === 'state.changed' && data?.kind === 'chat.queue' && data.sessionId === sessionId) void reload();
    });
    return () => { disposed = true; lifecycleGeneration.current += 1; unsubscribe(); };
  }, [sessionId]);

  useEffect(() => {
    if (editing && !queue?.items.some(item => item.id === editing.id)) setEditing(undefined);
  }, [editing, queue]);
  useEffect(() => { if (editing) editRef.current?.focus(); }, [editing]);

  const mutate = async (key: string, action: (epoch: number) => Promise<ChatQueueState>, applied?: () => void) => {
    if (!writable || leaseEpoch === undefined || busy) return;
    const actionSessionId = sessionId;
    const generation = lifecycleGeneration.current;
    const sequence = ++refreshSequence.current;
    setBusy(key);
    try {
      const next = await action(leaseEpoch);
      const alive = lifecycleGeneration.current === generation && currentSession.current === actionSessionId;
      if (alive && sequence === refreshSequence.current) onChange(next);
      if (alive) applied?.();
    } catch (error) {
      if (lifecycleGeneration.current === generation && currentSession.current === actionSessionId && sequence === refreshSequence.current) onIssue(String(error));
    } finally {
      if (lifecycleGeneration.current === generation && currentSession.current === actionSessionId) setBusy(undefined);
    }
  };
  const beginEdit = (item: ChatQueueItem) => { setEditing(item); setDraft(item.text); };
  const saveEdit = () => editing && void mutate(`edit:${editing.id}`, epoch => request('chat.queue.update', { sessionId, itemId: editing.id, text: draft.trim(), expectedRevision: editing.revision, operationId: operationId(), leaseEpoch: epoch }), () => setEditing(undefined));
  const onEditKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setEditing(undefined); }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); saveEdit(); }
  };

  if (!queue?.items.length) return null;
  return <section className="chat-queue" aria-label={copy('Prompt queue', '提示队列')} data-testid="chat-queue">
    <header className="chat-queue-header"><strong>{copy(`Queued (${queue.items.length})`, `队列中（${queue.items.length}）`)}</strong>{queue.paused && <span className="chat-queue-paused" role="status">{queuePauseReason(queue.pauseReason, zh)}</span>}{queue.paused && <button type="button" className="btn-subtle" disabled={!writable || Boolean(busy)} onClick={() => void mutate('resume', epoch => request('chat.queue.resume', { sessionId, operationId: operationId(), leaseEpoch: epoch }))}>{copy('Resume queue', '恢复队列')}</button>}{!queue.paused && <button type="button" className="btn-subtle" disabled={!writable || Boolean(busy)} onClick={() => void mutate('pause', epoch => request('chat.queue.pause', { sessionId, operationId: operationId(), leaseEpoch: epoch }))}>{copy('Pause queue', '暂停队列')}</button>}</header>
    <ol className="chat-queue-list">{queue.items.map((item, index) => <li key={item.id} data-testid="chat-queue-item" data-queue-item-id={item.id} className={`chat-queue-item is-${item.state}`}>
      {editing?.id === item.id
        ? <div className="chat-queue-edit"><label className="sr-only" htmlFor={`chat-queue-${item.id}`}>{copy('Queued prompt', '队列提示')}</label><textarea ref={editRef} id={`chat-queue-${item.id}`} aria-label={copy('Queued prompt', '队列提示')} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onEditKey} rows={3} disabled={Boolean(busy)} /><div><button type="button" className="btn-subtle" disabled={!draft.trim() || Boolean(busy)} onClick={saveEdit}>{copy('Save', '保存')}</button><button type="button" className="btn-subtle" disabled={Boolean(busy)} onClick={() => setEditing(undefined)}>{copy('Cancel', '取消')}</button></div></div>
        : <><div className="chat-queue-item-main"><span title={queueItemSummary(item, zh)}>{queueItemSummary(item, zh)}</span>{item.state === 'sending' && <small role="status">{copy('Sending…', '正在发送…')}</small>}{item.state === 'failed' && <small role="status">{item.error || copy('Send failed', '发送失败')}</small>}</div><div className="chat-queue-actions"><button type="button" className="btn-subtle" disabled={!writable || Boolean(busy) || item.state === 'sending'} aria-label={copy('Edit queued prompt', '编辑队列提示')} onClick={() => beginEdit(item)}>{copy('Edit', '编辑')}</button><button type="button" className="btn-subtle" disabled={!writable || Boolean(busy) || item.state === 'sending'} aria-label={copy('Delete queued prompt', '删除队列提示')} onClick={() => void mutate(`remove:${item.id}`, epoch => request('chat.queue.remove', { sessionId, itemId: item.id, operationId: operationId(), leaseEpoch: epoch }))}>{copy('Delete', '删除')}</button><button type="button" className="btn-subtle" disabled={!writable || Boolean(busy) || index === 0 || item.state === 'sending'} aria-label={copy('Move queued prompt up', '将队列提示上移')} onClick={() => void mutate(`up:${item.id}`, epoch => request('chat.queue.move', { sessionId, itemId: item.id, toIndex: index - 1, operationId: operationId(), leaseEpoch: epoch }))}>{copy('Up', '上移')}</button><button type="button" className="btn-subtle" disabled={!writable || Boolean(busy) || index === queue.items.length - 1 || item.state === 'sending'} aria-label={copy('Move queued prompt down', '将队列提示下移')} onClick={() => void mutate(`down:${item.id}`, epoch => request('chat.queue.move', { sessionId, itemId: item.id, toIndex: index + 1, operationId: operationId(), leaseEpoch: epoch }))}>{copy('Down', '下移')}</button>{idle && <button type="button" className="btn-subtle" disabled={!writable || Boolean(busy) || item.state === 'sending'} aria-label={copy('Send queued prompt now', '立即发送队列提示')} onClick={() => void mutate(`send:${item.id}`, epoch => request('chat.queue.send', { sessionId, itemId: item.id, operationId: operationId(), leaseEpoch: epoch }))}>{copy('Send now', '立即发送')}</button>}</div></>}
    </li>)}</ol>
  </section>;
}
