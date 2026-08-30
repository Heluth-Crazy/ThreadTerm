import { useCallback, useRef } from 'react';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import type { WorkspaceTab } from '../../lib/workspace/types';
import type { WorkspaceCatalogTabRef } from '../workspace/useWorkspaceCatalog';
import type { TerminalTabOpenResult } from '../workspace/useWorkspaceSession';

export type TerminalRecoveryTarget =
  | { kind: 'canonical' }
  | {
      kind: 'workspaceTab';
      ref: WorkspaceCatalogTabRef;
      canContinue: () => boolean;
    };

interface UseTerminalRecoveryOptions {
  mountCard: (cardId: string) => void;
  prepareTerminalTabForFocus: (card: TerminalCard) => Promise<TerminalTabOpenResult>;
  commitPreparedTerminalFocus: (cardId: string) => void;
  activateExistingWorkspaceTab: (ref: WorkspaceCatalogTabRef) => Promise<WorkspaceTab | null>;
  invalidateWorkspace: (workspaceId: string) => void;
  focusMountedCard: (cardId: string) => void;
  reportFailure: (cardId: string, error: unknown) => void;
}

/**
 * The single non-persisted recovery boundary for explicit terminal opens.
 * Store identity is always read live so archived cards never leak into the
 * normal focus path as stale render data.
 */
export function useTerminalRecovery({
  mountCard,
  prepareTerminalTabForFocus,
  commitPreparedTerminalFocus,
  activateExistingWorkspaceTab,
  invalidateWorkspace,
  focusMountedCard,
  reportFailure,
}: UseTerminalRecoveryOptions) {
  const inFlightRef = useRef(new Map<string, {
    generation: number;
    promise: Promise<boolean>;
  }>());
  const intentGenerationRef = useRef(0);

  return useCallback((cardId: string, target: TerminalRecoveryTarget = { kind: 'canonical' }) => {
    const joined = inFlightRef.current.get(cardId);
    if (joined && joined.generation === intentGenerationRef.current) return joined.promise;
    const intentGeneration = intentGenerationRef.current + 1;
    intentGenerationRef.current = intentGeneration;
    const isLatest = () => intentGenerationRef.current === intentGeneration;

    let operation!: Promise<boolean>;
    operation = (async () => {
      const store = useTerminalStore.getState();
      let card = store.cards.find((candidate) => candidate.id === cardId);
      if (!card) {
        if (!store.archivedCards.some((candidate) => candidate.id === cardId)) {
          reportFailure(cardId, new Error('The terminal is no longer available.'));
          return false;
        }
        store.restoreArchivedCard(cardId);
        card = useTerminalStore.getState().cards.find((candidate) => candidate.id === cardId);
        if (!card) return false;
      }

      try {
        if (target.kind === 'workspaceTab') {
          const activated = await activateExistingWorkspaceTab(target.ref);
          if (!isLatest() || !target.canContinue()) return false;
          if (activated) {
            // Use the existing TerminalView surface owner only once a valid
            // target exists; mounting schedules normal create-or-attach and
            // does not claim runtime readiness.
            mountCard(card.id);
            focusMountedCard(card.id);
            return true;
          }
          // A newer selection intentionally cancelled this exact activation;
          // it is not a stale catalog ref and must not recreate a tab.
          invalidateWorkspace(target.ref.workspaceId);
        }

        const prepared = await prepareTerminalTabForFocus(card);
        if (!isLatest()) return false;
        switch (prepared.outcome) {
          case 'opened':
            mountCard(card.id);
            commitPreparedTerminalFocus(card.id);
            focusMountedCard(card.id);
            return true;
          case 'failed':
            reportFailure(card.id, prepared.error);
            return false;
          case 'superseded':
            return false;
        }
      } catch (error) {
        if (isLatest()) reportFailure(card.id, error);
        return false;
      }
    })().finally(() => {
      const current = inFlightRef.current.get(cardId);
      if (current?.generation === intentGeneration && current.promise === operation) {
        inFlightRef.current.delete(cardId);
      }
    });
    inFlightRef.current.set(cardId, { generation: intentGeneration, promise: operation });
    return operation;
  }, [
    activateExistingWorkspaceTab,
    commitPreparedTerminalFocus,
    focusMountedCard,
    invalidateWorkspace,
    mountCard,
    prepareTerminalTabForFocus,
    reportFailure,
  ]);
}
