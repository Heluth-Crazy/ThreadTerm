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

  // Direct text field (Claude text events, tool_result text)
  if (typeof data.text === 'string') return stripMarkdown(data.text);

  // Claude content array (system, user, or assistant message)
  if (data.content) {
    if (typeof data.content === 'string') return stripMarkdown(data.content);
    if (Array.isArray(data.content)) {
      const textParts = data.content
        .filter((b: any) => b.type === 'text' && b.text)
        .map((b: any) => b.text);
      if (textParts.length > 0) return stripMarkdown(textParts.join(' '));
    }
  }

  // Claude assistant message: { type: "assistant", message: { content: [...] } }
  // Codex agent_message: { type: "item", message: { content: "..." } }
  if (data.message) {
    if (typeof data.message === 'string') return stripMarkdown(data.message);
    const inner = extractTextFromData(data.message);
    if (inner) return inner;
  }

  // Claude result message: { type: "result", output: "..." }
  if (typeof data.output === 'string') return stripMarkdown(data.output);

  // Claude tool use: { type: "tool_use", name: "bash", input: {...} }
  if (data.name && data.input !== undefined) return `🔧 ${data.name}`;

  // Codex command_execution
  if (data.command) return `$ ${String(data.command).slice(0, 80)}`;

  // Delta text (streaming)
  if (data.delta?.text) return stripMarkdown(data.delta.text);

  // Error messages
  if (typeof data.error === 'string') return data.error;
  if (data.error?.message) return String(data.error.message);

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
  const completeLastStreamingSnapshot = useLiveGridStore((s) => s.completeLastStreamingSnapshot);
  const cards = useLiveGridStore((s) => s.cards);

  const listenersRef = useRef<Map<string, Set<MessageCallback>>>(new Map());
  const pushSnapshotRef = useRef(pushSnapshot);
  pushSnapshotRef.current = pushSnapshot;
  const completeLastStreamingSnapshotRef = useRef(completeLastStreamingSnapshot);
  completeLastStreamingSnapshotRef.current = completeLastStreamingSnapshot;
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
    if (messageSequence <= lastProcessedSeqRef.current) return;
    lastProcessedSeqRef.current = messageSequence;

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
    const isComplete = type.includes('complete') || type === 'session-aborted';
    const isError = type.includes('error');

    if (text) {
      const snap: MessageSnapshot = {
        id: `${sid}-${messageSequence}`,
        kind: messageToKind(type),
        textPreview: truncate(text, 120),
        streaming: isStreaming && !isComplete,
        timestamp: Date.now(),
      };
      pushSnapshotRef.current(sid, snap);
    } else if (isComplete || isError) {
      completeLastStreamingSnapshotRef.current(sid);
    }
  }, [latestMessage, messageSequence]);

  return { registerListener, sendToSession };
}
