import { useCallback, useEffect, useMemo, useState } from 'react';
import { isTauriEnv, providerSessions } from '../../lib/tauri-bridge';
import { logger } from '../../lib/logger';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import {
  buildTerminalLaunchCommand,
  type TerminalLaunchCommand,
} from './providerSession';

export type ProviderSessionLaunchStatus =
  | 'ready'
  | 'checking'
  | 'unavailable'
  | 'error';

interface ResolutionState {
  requestedSessionId: string;
  status: Exclude<ProviderSessionLaunchStatus, 'ready'> | 'resolved';
  resumeSessionId?: string;
}

export interface ValidatedProviderSessionLaunch {
  lifecycleCard: TerminalCard | null;
  launch: TerminalLaunchCommand | null;
  status: ProviderSessionLaunchStatus;
  retry: () => void;
}

/**
 * Prevents a persisted Codex binding from reaching the PTY until Rust has
 * resolved it to an interactive root session. Legacy cards may contain a
 * subagent rollout id; those bindings must migrate to their ancestor rather
 * than silently losing history by starting a new session.
 */
export function useValidatedProviderSessionLaunch(
  card: TerminalCard | null,
  defaultCommand?: string,
): ValidatedProviderSessionLaunch {
  const markProviderSessionBound = useTerminalStore(
    (state) => state.markProviderSessionBound,
  );
  const candidateSessionId =
    card?.terminalType === 'codex'
    && !card.command?.trim()
    && card.providerSessionState === 'bound'
      ? card.providerSessionId?.trim() || null
      : null;
  const cardId = card?.id ?? null;
  const shouldValidate = Boolean(candidateSessionId) && isTauriEnv();
  const [resolution, setResolution] = useState<ResolutionState | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => {
    setRetryNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!cardId || !candidateSessionId || !shouldValidate) return;

    let cancelled = false;
    setResolution({
      requestedSessionId: candidateSessionId,
      status: 'checking',
    });

    void providerSessions
      .resolveResume('codex', candidateSessionId)
      .then((target) => {
        if (cancelled) return;
        const resumeSessionId = target?.id.trim();
        if (!resumeSessionId) {
          setResolution({
            requestedSessionId: candidateSessionId,
            status: 'unavailable',
          });
          return;
        }

        setResolution({
          requestedSessionId: candidateSessionId,
          resumeSessionId,
          status: 'resolved',
        });
        if (resumeSessionId !== candidateSessionId) {
          markProviderSessionBound(cardId, resumeSessionId);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        logger.warn('[provider-session] Codex resume resolution failed', error);
        setResolution({
          requestedSessionId: candidateSessionId,
          status: 'error',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    candidateSessionId,
    cardId,
    markProviderSessionBound,
    retryNonce,
    shouldValidate,
  ]);

  const isCurrentResolution =
    resolution?.requestedSessionId === candidateSessionId;
  const status: ProviderSessionLaunchStatus = !shouldValidate
    ? 'ready'
    : !isCurrentResolution || resolution?.status === 'checking'
      ? 'checking'
      : resolution?.status === 'resolved'
        ? 'ready'
        : resolution?.status ?? 'checking';

  return useMemo(() => {
    if (!card) {
      return { lifecycleCard: null, launch: null, status: 'ready' as const, retry };
    }
    if (status !== 'ready') {
      return { lifecycleCard: card, launch: null, status, retry };
    }

    const resumeSessionId =
      isCurrentResolution && resolution?.status === 'resolved'
        ? resolution.resumeSessionId
        : undefined;
    const lifecycleCard = resumeSessionId
      ? { ...card, providerSessionId: resumeSessionId }
      : card;
    return {
      lifecycleCard,
      launch: buildTerminalLaunchCommand(lifecycleCard, defaultCommand),
      status,
      retry,
    };
  }, [
    card,
    defaultCommand,
    isCurrentResolution,
    resolution,
    retry,
    status,
  ]);
}
