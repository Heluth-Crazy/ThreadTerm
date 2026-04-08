import { useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useLiveGridStore } from '../stores/liveGridStore';
import type { MessageSnapshot } from '../stores/liveGridStore';

type MessageCallback = (message: any) => void;

export function useMultiSessionDispatcher() {
  const { latestMessage, messageSequence, sendMessage } = useWebSocket();
  const upsertSnapshot = useLiveGridStore((s) => s.upsertSnapshot);
  const cards = useLiveGridStore((s) => s.cards);

  const listenersRef = useRef<Map<string, Set<MessageCallback>>>(new Map());
  const lastProcessedSeqRef = useRef(0);

  const registerListener = useCallback((sessionId: string, cb: MessageCallback) => {
    if (!listenersRef.current.has(sessionId)) {
      listenersRef.current.set(sessionId, new Set());
    }
    listenersRef.current.get(sessionId)!.add(cb);
    return () => {
      const set = listenersRef.current.get(sessionId);
      if (set) {
        set.delete(cb);
        if (set.size === 0) listenersRef.current.delete(sessionId);
      }
    };
  }, []);

  const sendToSession = useCallback(
    (sessionId: string, command: string, options: Record<string, unknown>) => {
      const card = cards.find((c) => c.sessionId === sessionId);
      if (!card) return false;

      const provider = card.provider || 'claude';
      const type = provider === 'codex' ? 'codex-command' : 'claude-command';

      // Push a user snapshot so the card shows the outgoing message
      const userSnap: MessageSnapshot = {
        id: `${sessionId}-user-${Date.now()}`,
        kind: 'user',
        text: command,
        streaming: false,
        timestamp: Date.now(),
      };
      upsertSnapshot(sessionId, userSnap);

      return sendMessage({
        type,
        command,
        options: { sessionId, ...options },
      });
    },
    [cards, sendMessage, upsertSnapshot],
  );

  // Dispatch WS messages to per-session listeners (used by focused card, etc.)
  // Snapshot pushing is handled by useLiveGridSnapshotSync in App.tsx.
  useEffect(() => {
    if (!latestMessage) return;
    if (messageSequence <= lastProcessedSeqRef.current) return;
    lastProcessedSeqRef.current = messageSequence;

    const msg = latestMessage;
    const sid = msg.sessionId || msg.data?.sessionId;
    if (!sid) return;

    const callbacks = listenersRef.current.get(sid);
    if (callbacks) {
      callbacks.forEach((cb) => cb(msg));
    }
  }, [latestMessage, messageSequence]);

  return { registerListener, sendToSession };
}
