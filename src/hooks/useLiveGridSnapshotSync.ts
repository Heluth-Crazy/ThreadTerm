/**
 * useLiveGridSnapshotSync
 *
 * Always-mounted hook (called in App.tsx alongside useSessionStatusTracker)
 * that converts incoming WebSocket messages into LiveGrid card snapshots.
 *
 * This must run at the App level so snapshots are captured even when the user
 * is on a different tab (chat, settings, overview, etc.).
 */
import { useEffect, useRef } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useLiveGridStore } from '../stores/liveGridStore';
import type { MessageSnapshot } from '../stores/liveGridStore';

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

export function extractTextFromData(data: any): string {
  if (!data) return '';
  if (typeof data === 'string') return stripMarkdown(data);

  // Direct text field (Claude text events, tool_result text)
  if (typeof data.text === 'string') return stripMarkdown(data.text);

  // Content array (Claude content blocks, Codex output_text blocks)
  if (data.content) {
    if (typeof data.content === 'string') return stripMarkdown(data.content);
    if (Array.isArray(data.content)) {
      const textParts = data.content
        .filter((b: any) => (b.type === 'text' || b.type === 'output_text' || b.type === 'input_text') && b.text)
        .map((b: any) => b.text);
      if (textParts.length > 0) return stripMarkdown(textParts.join(' '));
    }
  }

  // Claude assistant message: { type: "assistant", message: { content: [...] } }
  // Codex agent_message: { message: { content: "..." } }
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

  // Codex mcp_tool_call: { itemType: "mcp_tool_call", tool: "..." }
  if (data.itemType === 'mcp_tool_call' && data.tool) return `🔧 ${data.tool}`;

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

export function useLiveGridSnapshotSync(): void {
  const { latestMessage, messageSequence } = useWebSocket();
  const lastProcessedSeqRef = useRef(0);

  useEffect(() => {
    if (!latestMessage) return;
    if (messageSequence <= lastProcessedSeqRef.current) return;
    lastProcessedSeqRef.current = messageSequence;

    const msg = latestMessage;
    const type = typeof msg.type === 'string' ? msg.type : '';
    const sid = msg.sessionId || msg.data?.sessionId;

    // Handle session-created: remap card session IDs when the server assigns a
    // different real session ID than the one the card originally stored.
    if (type === 'session-created' && sid) {
      const originalSid =
        msg.originalSessionId || msg.data?.originalSessionId;
      if (originalSid && originalSid !== sid) {
        const store = useLiveGridStore.getState();
        const hasCard = store.cards.some((c) => c.sessionId === originalSid);
        if (hasCard) {
          store.updateCardSessionId(originalSid, sid);
        }
      }
      return;
    }

    if (!sid) return;

    // Only push snapshots for sessions that are in a LiveGrid card
    const store = useLiveGridStore.getState();
    const isCardSession = store.cards.some((c) => c.sessionId === sid);
    if (!isCardSession) return;

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
      store.pushSnapshot(sid, snap);
    } else if (isComplete || isError) {
      store.completeLastStreamingSnapshot(sid);
    }
  }, [latestMessage, messageSequence]);
}
