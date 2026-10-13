import { useContext, useEffect, useRef, useState } from 'react';
import type { Session } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { acquireControl } from '../controlLease';
import { forkDisabledReason, rememberForkNotice, peekForkNotice, takeForkNotice, type ForkMode } from '../chatFork';
import { SessionSurfaceContext, SurfaceActions } from './SessionSurfaceContext';
import './chat-fork.css';

export function useChatFork(session: Session, running: boolean, zh: boolean, onIssue: (issue: string) => void) {
  const surface = useContext(SessionSurfaceContext);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false), generation = useRef(0), pendingFork = useRef<string | undefined>(undefined);
  useEffect(() => { generation.current++; pendingFork.current = undefined; return () => { generation.current++; pendingFork.current = undefined; }; }, [session.id]);
  const disabledReason = forkDisabledReason(running, busy, zh);
  const accept = (child: Session, mode: ForkMode) => {
    rememberForkNotice(child.id, mode);
    surface?.openFork?.(child);
  };
  const fork = async (itemId?: string) => {
    if (running || locked.current) return;
    locked.current = true; setBusy(true);
    const current = generation.current;
    let control: Awaited<ReturnType<typeof acquireControl>> | undefined;
    let lost = false;
    try {
      control = await acquireControl(session.id, () => { lost = true; });
      await control.check();
      if (current !== generation.current || lost) return;
      const id = operationId();
      pendingFork.current = id;
      const result = await request('chat.fork', {sessionId: session.id, itemId, operationId: id, leaseEpoch: control.epoch});
      if (current === generation.current) {
        // The chat.forked event may have already opened the child; only accept
        // the RPC result while this fork is still the pending one.
        if (pendingFork.current === id) { pendingFork.current = undefined; accept(result.session, result.mode); }
        return result.session;
      }
    } catch (error) {
      // A lost response that the chat.forked event already resolved is not an error.
      if (current === generation.current && pendingFork.current !== undefined) { pendingFork.current = undefined; onIssue(error instanceof Error ? error.message : String(error)); }
    } finally {
      control?.release(); locked.current = false;
      if (current === generation.current) setBusy(false);
    }
  };
  // A lost chat.fork response still opens the child the event reported.
  const acceptEvent = (operationId: string, child: Session, mode: ForkMode) => {
    if (pendingFork.current !== operationId) return false;
    pendingFork.current = undefined;
    accept(child, mode);
    return true;
  };
  return { busy, disabledReason, fork, accept, acceptEvent };
}

export function ChatForkButton({ itemId, disabledReason, busy, onFork, zh }: {itemId?: string; disabledReason?: string; busy?: boolean; onFork: (itemId?: string) => void; zh: boolean}) {
  const label = busy ? (zh ? '正在分叉…' : 'Forking…') : itemId ? (zh ? '从这里分叉' : 'Fork from here') : (zh ? '分叉会话' : 'Fork session');
  return <button type="button" className={`btn btn-sm${itemId ? ' chat-message-action' : ' btn-ghost'}`} data-testid={itemId ? 'chat-fork-reply' : 'chat-fork-session'} disabled={Boolean(disabledReason)} title={disabledReason} onClick={() => onFork(itemId)}>{label}</button>;
}

export function ChatForkStatus({ session, zh, onOpenSession }: {session: Session; zh: boolean; onOpenSession?: (id: string) => void}) {
  const [notice, setNotice] = useState(() => peekForkNotice(session.id));
  useEffect(() => { takeForkNotice(session.id); }, [session.id]);
  const origin = session.forkedFrom;
  return <>
    {origin && <div className="chat-fork-origin" data-testid="chat-fork-origin"><span>{zh ? '分叉自' : 'Forked from'}</span><button type="button" className="btn btn-sm btn-ghost" disabled={!onOpenSession} onClick={() => onOpenSession?.(origin.sessionId)}>{origin.title || origin.sessionId}</button></div>}
    {notice && <div className="chat-fork-toast" role="status" data-testid="chat-fork-toast"><span>{notice === 'native' ? (zh ? '已分叉（原生）' : 'Forked (native)') : (zh ? '已分叉（复制上下文）' : 'Forked (copied context)')}</span><button type="button" className="btn btn-sm btn-ghost" aria-label={zh ? '关闭通知' : 'Dismiss notice'} onClick={() => setNotice(undefined)}>×</button></div>}
  </>;
}

export function ChatForkMenu(props: Parameters<typeof ChatForkButton>[0]) {
  return <SurfaceActions slot="menu"><ChatForkButton {...props}/></SurfaceActions>;
}
