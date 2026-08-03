import { useEffect, useMemo, useRef } from 'react';
import {
  agentSessionMetadataCacheKey,
  isAgentSessionProvider,
  type AgentSessionMetadataKey,
} from '../../types/agentSession';
import type { TerminalCard } from '../../types/terminal';
import {
  METADATA_CACHE_FAILURE_TTL_MS,
  useAgentSessionMetadataCache,
} from '../../stores/agentSessionMetadataCache';
import { effectiveWorktreePath } from '../../lib/worktreePaths';

/**
 * Batch-load native session metadata for bound Agent cards visible in the
 * current workspace. Presentation falls back immediately when cache misses.
 */
export function useWorkspaceAgentMetadata(cards: TerminalCard[]): void {
  const ensureKeys = useAgentSessionMetadataCache((s) => s.ensureKeys);
  const invalidateKey = useAgentSessionMetadataCache((s) => s.invalidateKey);

  const bindings = useMemo(() => {
    const next: Array<{ cardId: string; key: AgentSessionMetadataKey }> = [];
    for (const card of cards) {
      if (!isAgentSessionProvider(card.terminalType)) continue;
      if (card.providerSessionState !== 'bound' || !card.providerSessionId) continue;
      next.push({
        cardId: card.id,
        key: {
          provider: card.terminalType,
          sessionId: card.providerSessionId,
          projectPath: effectiveWorktreePath(card),
        },
      });
    }
    return next;
  }, [cards]);
  const previousBindingsRef = useRef(new Map<string, AgentSessionMetadataKey>());

  useEffect(() => {
    const previous = previousBindingsRef.current;
    const next = new Map(bindings.map(({ cardId, key }) => [cardId, key]));
    for (const [cardId, oldKey] of previous) {
      const newKey = next.get(cardId);
      if (
        !newKey
        || agentSessionMetadataCacheKey(
          newKey.provider,
          newKey.sessionId,
          newKey.projectPath,
        ) !== agentSessionMetadataCacheKey(
          oldKey.provider,
          oldKey.sessionId,
          oldKey.projectPath,
        )
      ) {
        invalidateKey(oldKey.provider, oldKey.sessionId, oldKey.projectPath);
      }
    }
    previousBindingsRef.current = next;

    const keys = bindings.map(({ key }) => key);
    if (keys.length === 0) return;

    let cancelled = false;
    let refreshTimer: number | undefined;

    const scheduleNextRefresh = () => {
      if (cancelled) return;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      const entries = useAgentSessionMetadataCache.getState().entries;
      const fallbackExpiry = Date.now() + METADATA_CACHE_FAILURE_TTL_MS;
      const nextExpiry = keys.reduce((earliest, key) => {
        const cacheKey = agentSessionMetadataCacheKey(
          key.provider,
          key.sessionId,
          key.projectPath,
        );
        return Math.min(earliest, entries.get(cacheKey)?.expiresAt ?? fallbackExpiry);
      }, Number.POSITIVE_INFINITY);
      const delay = Math.max(1, nextExpiry - Date.now() + 1);
      refreshTimer = window.setTimeout(refresh, delay);
    };

    const refresh = () => {
      if (cancelled) return;
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
      void ensureKeys(keys).finally(scheduleNextRefresh);
    };

    window.addEventListener('focus', refresh);
    refresh();
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [bindings, ensureKeys, invalidateKey]);

  useEffect(() => () => {
    for (const key of previousBindingsRef.current.values()) {
      invalidateKey(key.provider, key.sessionId, key.projectPath);
    }
    previousBindingsRef.current.clear();
  }, [invalidateKey]);
}

export function useBoundSessionMetadata(card: TerminalCard) {
  const entries = useAgentSessionMetadataCache((s) => s.entries);
  if (
    !isAgentSessionProvider(card.terminalType)
    || card.providerSessionState !== 'bound'
    || !card.providerSessionId
  ) {
    return null;
  }
  const key = agentSessionMetadataCacheKey(
    card.terminalType,
    card.providerSessionId,
    effectiveWorktreePath(card),
  );
  const entry = entries.get(key);
  if (!entry || entry.status !== 'found') return null;
  return entry.summary;
}
