import { useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useLiveGridStore } from '../stores/liveGridStore';
import type { MessageSnapshot } from '../stores/liveGridStore';

type MessageCallback = (message: any) => void;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/`[^`]+`/g, '[code]')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/>\s/g, '')
    .replace(/[-*+]\s/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

function extractTextFromData(data: any): string {
  if (!data) return '';
  if (typeof data === 'string') return stripMarkdown(data);
  if (data.text) return stripMarkdown(data.text);
  if (data.content) {
    if (typeof data.content === 'string') return stripMarkdown(data.content);
    if (Array.isArray(data.content)) {
      const textParts = data.content
        .filter((b: any) => b.type === 'text' && b.text)
        .map((b: any) => b.text);
      return stripMarkdown(textParts.join(' '));
    }
  }
  if (data.message) return stripMarkdown(String(data.message));
  if (data.delta?.text) return stripMarkdown(data.delta.text);
  return '';
}

function messageToKind(type: string): MessageSnapshot['kind'] {
  if (type.includes('error') || type === 'session-aborted') return 'error';
  if (type.includes('permission') || type.includes('tool')) return 'tool';
  if (type.includes('response') || type.includes('complete')) return 'assistant';
  return 'system';
}

export function useMultiSessionDispatcher() {
  const { latestMessage, messageSequence, sendMessage } = useWebSocket();
  const pushSnapshot = useLiveGridStore((s) => s.pushSnapshot);
  const cards = useLiveGridStore((s) => s.cards);

  const listenersRef = useRef<Map<string, Set<MessageCallback>>>(new Map());

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

      return sendMessage({
        type,
        command,
        options: { sessionId, ...options },
      });
    },
    [cards, sendMessage],
  );

  useEffect(() => {
    if (!latestMessage) return;

    const msg = latestMessage;
    const sid = msg.sessionId || msg.data?.sessionId;
    if (!sid) return;

    // Dispatch to registered listeners
    const callbacks = listenersRef.current.get(sid);
    if (callbacks) {
      callbacks.forEach((cb) => cb(msg));
    }

    // Build snapshot
    const type = msg.type || '';
    const isStreaming = type.includes('response') && !type.includes('complete');
    const text = extractTextFromData(msg.data || msg);

    if (text || type.includes('complete') || type.includes('error') || type === 'session-aborted') {
      const snap: MessageSnapshot = {
        id: `${sid}-${messageSequence}`,
        kind: messageToKind(type),
        textPreview: truncate(text || type, 120),
        streaming: isStreaming,
        timestamp: Date.now(),
      };
      pushSnapshot(sid, snap);
    }
  }, [latestMessage, messageSequence, pushSnapshot]);

  return { registerListener, sendToSession };
}
