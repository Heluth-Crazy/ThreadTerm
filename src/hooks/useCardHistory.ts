/**
 * useCardHistory
 *
 * When a LiveCard mounts (e.g. after page refresh), loads session message
 * history from the backend API and populates the liveGridStore so the card
 * shows previous messages instead of appearing blank.
 */
import { useEffect, useRef } from 'react';
import { sessions as tauriSessions } from '../lib/tauri-bridge';
import { useLiveGridStore } from '../stores/liveGridStore';
import type { MessageSnapshot } from '../stores/liveGridStore';

function normalizeHistoryToSnapshots(
  messages: any[],
): MessageSnapshot[] {
  const snapshots: MessageSnapshot[] = [];

  for (const item of messages) {
    const timestamp = item?.timestamp ? new Date(item.timestamp).getTime() : Date.now();

    // Skip thinking / internal trace messages
    const itemType = typeof item?.type === 'string' ? item.type.toLowerCase() : '';
    if (itemType.includes('thinking') || itemType.includes('redacted')) continue;

    // Determine role
    const role =
      item?.message?.role ||
      item?.role ||
      item?.content?.role ||
      item?.content?.message?.role ||
      '';

    // Extract text content
    const rawContent =
      item?.message?.content ??
      item?.content?.content ??
      item?.content?.message?.content ??
      item?.content ??
      item?.text ??
      '';

    let text = '';

    if (typeof rawContent === 'string') {
      text = rawContent;
    } else if (Array.isArray(rawContent)) {
      const textParts: string[] = [];
      for (const block of rawContent) {
        if (block?.type === 'tool_use') {
          snapshots.push({
            id: block.id || `hist-tool-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'tool',
            text: `🔧 ${block.name || 'Tool'}`,
            streaming: false,
            timestamp,
            fromHistory: true,
          });
          continue;
        }
        if (block?.type === 'tool_result') {
          const output =
            typeof block.content === 'string'
              ? block.content
              : typeof block.output === 'string'
                ? block.output
                : '';
          if (output) {
            snapshots.push({
              id: block.id || `hist-result-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'tool',
              text: output.slice(0, 200),
              streaming: false,
              timestamp,
              fromHistory: true,
            });
          }
          continue;
        }
        // text blocks
        const t =
          typeof block === 'string'
            ? block
            : typeof block?.text === 'string'
              ? block.text
              : '';
        if (t) textParts.push(t);
      }
      text = textParts.join('\n\n').trim();
    } else if (rawContent && typeof rawContent === 'object') {
      text = String(rawContent.text || rawContent.content || '');
    }

    // Handle tool_use / tool_result at item level
    if (itemType === 'tool_use') {
      snapshots.push({
        id: item.id || `hist-tool-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'tool',
        text: `🔧 ${item.toolName || item.name || 'Tool'}`,
        streaming: false,
        timestamp,
        fromHistory: true,
      });
      continue;
    }
    if (itemType === 'tool_result') {
      const output =
        typeof item.output === 'string' ? item.output :
        typeof item.toolResult?.content === 'string' ? item.toolResult.content : '';
      if (output) {
        snapshots.push({
          id: item.id || `hist-result-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'tool',
          text: output.slice(0, 200),
          streaming: false,
          timestamp,
          fromHistory: true,
        });
      }
      continue;
    }

    if (!text) continue;

    const kind: MessageSnapshot['kind'] =
      role === 'user' ? 'user' :
      role === 'assistant' ? 'assistant' :
      role === 'tool' ? 'tool' : 'assistant';

    snapshots.push({
      id: item.id || `hist-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      text: text.slice(0, 5000),
      streaming: false,
      timestamp,
      fromHistory: true,
    });
  }

  // Keep last 50 messages to avoid overwhelming the card
  return snapshots.slice(-50);
}

export function useCardHistory(
  sessionId: string,
  projectId: string,
  provider: string,
): void {
  const setSessionSnapshots = useLiveGridStore((s) => s.setSessionSnapshots);
  const existingSnapshots = useLiveGridStore((s) => s.messageSnapshots[sessionId]);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    if (existingSnapshots && existingSnapshots.length > 0) {
      loadedRef.current = true;
      return;
    }

    loadedRef.current = true;

    async function load() {
      try {
        const rawMessages = await tauriSessions.messages(
          projectId,
          sessionId,
          undefined,
          0,
          provider,
        );

        if (!Array.isArray(rawMessages) || rawMessages.length === 0) return;

        const snaps = normalizeHistoryToSnapshots(rawMessages);
        if (snaps.length > 0) {
          setSessionSnapshots(sessionId, snaps);
        }
      } catch {
        // Silently fail — history is nice-to-have
      }
    }

    void load();
  }, [sessionId, projectId, provider, setSessionSnapshots, existingSnapshots]);
}
