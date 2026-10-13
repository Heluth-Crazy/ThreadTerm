import { useEffect, useRef, useState } from 'react';
import type { ChatFeedbackNote } from '@threadterm/protocol';
import { operationId, request, subscribeEvents } from '../bridge';
import { applyNoteEvent, notesMessage, sortNotes, waitingNotes } from '../feedbackNotes';
import './feedback-notes.css';

type Props = {
  sessionId: string;
  /** The running turn, when one is live. Unread notes at turn end offer a resend. */
  liveTurn: string | undefined;
  leaseEpoch: number | undefined;
  writable: boolean;
  busy: boolean;
  zh: boolean;
  onIssue: (message: string) => void;
};

/**
 * The strip above the composer. It renders nothing while no notes exist for the
 * current or last turn, and it never resends automatically: unread notes at
 * turn end only offer "Send as message".
 */
export function ChatNotes({ sessionId, liveTurn, leaseEpoch, writable, busy, zh, onIssue }: Props) {
  const [notes, setNotes] = useState<ChatFeedbackNote[]>([]);
  const [sending, setSending] = useState<string>();
  const currentSession = useRef(sessionId); currentSession.current = sessionId;
  const lifecycleGeneration = useRef(0);
  const refreshSequence = useRef(0);
  const copy = (en: string, cn: string) => zh ? cn : en;

  useEffect(() => {
    let disposed = false;
    const generation = ++lifecycleGeneration.current;
    setNotes([]); setSending(undefined);
    const load = () => {
      const sequence = ++refreshSequence.current;
      return request('chat.feedback.read', { sessionId }).then(read => {
        if (!disposed && lifecycleGeneration.current === generation && currentSession.current === sessionId && sequence === refreshSequence.current) setNotes(sortNotes(read.notes));
      }).catch(error => {
        if (!disposed && lifecycleGeneration.current === generation && currentSession.current === sessionId && sequence === refreshSequence.current) onIssue(String(error));
      });
    };
    void load();
    const unsubscribe = subscribeEvents(event => {
      const data = event.data as { sessionId?: unknown; notes?: unknown; removedIds?: unknown; state?: unknown } | null;
      if (event.event === 'runtime.transport') {
        if (data?.state === 'disconnected' || data?.state === 'incompatible') refreshSequence.current += 1;
        if (data?.state === 'reconnected') void load();
        return;
      }
      if (event.event !== 'chat.feedback' || data?.sessionId !== sessionId) return;
      const incoming = Array.isArray(data.notes) ? data.notes as ChatFeedbackNote[] : [];
      const removed = Array.isArray(data.removedIds) ? data.removedIds.filter((id): id is string => typeof id === 'string') : [];
      setNotes(current => applyNoteEvent(current, sessionId, incoming, removed));
    });
    return () => { disposed = true; lifecycleGeneration.current += 1; unsubscribe(); };
  }, [sessionId]);

  const sendNotes = async (targets: ChatFeedbackNote[]) => {
    if (!writable || leaseEpoch === undefined || !targets.length || sending) return;
    const generation = lifecycleGeneration.current;
    setSending(targets.length === 1 ? targets[0]!.id : 'all');
    try {
      await request('chat.send', { sessionId, text: notesMessage(targets), operationId: operationId(), leaseEpoch });
      const dismissed = await request('chat.feedback.dismiss', { sessionId, noteIds: targets.map(note => note.id), operationId: operationId(), leaseEpoch });
      if (lifecycleGeneration.current === generation && currentSession.current === sessionId) {
        const removed = new Set(dismissed.removed);
        setNotes(current => current.filter(note => !removed.has(note.id)));
      }
    } catch (error) {
      if (lifecycleGeneration.current === generation && currentSession.current === sessionId) onIssue(String(error));
    } finally {
      if (lifecycleGeneration.current === generation && currentSession.current === sessionId) setSending(undefined);
    }
  };

  if (!notes.length) return null;
  const waiting = waitingNotes(notes);
  const canSend = !liveTurn && writable && leaseEpoch !== undefined && !busy && !sending;
  return <section className="chat-notes" aria-label={copy('Feedback notes', '反馈备注')} data-testid="chat-notes">
    <header className="chat-notes-header">
      <strong>{copy(`Feedback notes (${notes.length})`, `反馈备注（${notes.length}）`)}</strong>
      {!liveTurn && waiting.length > 1 && <button type="button" className="btn-subtle" data-testid="notes-send-all" disabled={!canSend} onClick={() => void sendNotes(waiting)}>{copy('Send all as message', '全部作为消息发送')}</button>}
    </header>
    <ul className="chat-notes-list">{notes.map(note => <li className={`chat-notes-item is-${note.status}`} key={note.id} data-testid="chat-note" data-note-status={note.status}>
      <div className="chat-notes-item-head">
        <span className={`chat-note-status is-${note.status}`} role="status">{note.status === 'received' ? copy('Received', '已接收') : copy('Waiting', '等待中')}</span>
        {!liveTurn && note.status === 'waiting' && <button type="button" className="btn-subtle" data-testid="note-send-message" disabled={!canSend} onClick={() => void sendNotes([note])}>{copy('Send as message', '作为消息发送')}</button>}
      </div>
      <p className="chat-note-text" title={note.text}>{note.text}</p>
    </li>)}</ul>
  </section>;
}
