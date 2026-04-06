import { useEffect, useRef } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useSessionStatusStore } from '../stores/sessionStatusStore';
import type { AttentionReason } from '../stores/sessionStatusStore';

export function useSessionStatusTracker(): void {
  const { latestMessage, messageSequence } = useWebSocket();
  const lastProcessedSequenceRef = useRef(0);

  useEffect(() => {
    useSessionStatusStore.getState().pruneStale();
  }, []);

  useEffect(() => {
    if (!latestMessage || messageSequence <= lastProcessedSequenceRef.current) return;
    lastProcessedSequenceRef.current = messageSequence;

    const msg = latestMessage as Record<string, unknown>;
    const type = typeof msg.type === 'string' ? msg.type : '';
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
    if (!sessionId) return;

    const provider = type.startsWith('codex-') ? 'codex' as const
      : type.startsWith('claude-') ? 'claude' as const
      : undefined;

    const store = useSessionStatusStore.getState();
    switch (type) {
      case 'session-created':
      case 'claude-response':
      case 'codex-response':
        store.setProcessing(sessionId, provider);
        break;
      case 'claude-complete':
      case 'codex-complete':
        store.setCompleted(sessionId);
        break;
      case 'claude-error':
      case 'codex-error':
      case 'error':
        store.setNeedsAttention(sessionId, 'error' as AttentionReason);
        break;
      case 'claude-permission-request':
        store.setNeedsAttention(sessionId, 'permission' as AttentionReason);
        break;
      case 'session-aborted':
        store.setNeedsAttention(sessionId, 'aborted' as AttentionReason);
        break;
    }
  }, [latestMessage, messageSequence]);
}
