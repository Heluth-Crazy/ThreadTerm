import { useEffect, useMemo, useState } from 'react';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';
import {
  deriveAttentionItems,
  deriveWorkbenchSummary,
  filterWorkbenchCards,
} from '../../lib/workbench/deriveAttentionItems';
import { deriveExecutionGroups } from '../../lib/workbench/deriveExecutionGroups';
import {
  deriveFollowedCards,
  deriveProjectWorkbenchOverviews,
  deriveWorkbenchScopeAttentionCounts,
} from '../../lib/workbench/deriveFollowedTerminals';
import { useCodexRequestStore } from '../../stores/codexRequestStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import type { TerminalCard } from '../../types/terminal';

interface WorkbenchModelInput {
  cards: readonly TerminalCard[];
  selectedProjectPath: string | null;
  selectedWorktreePath: string | null;
}

interface WorkbenchModelSources {
  notifications: ReturnType<typeof useTerminalStore.getState>['notifications'];
  supervisorAlerts: ReturnType<typeof useSupervisorStore.getState>['alerts'];
  codexRequests: ReturnType<typeof useCodexRequestStore.getState>['requests'];
  followedCardIds: ReturnType<typeof useWorkbenchStore.getState>['followedCardIds'];
  rules: ReturnType<typeof useWorkbenchStore.getState>['rules'];
  now: number;
}

export function useWorkbenchModel({
  cards,
  selectedProjectPath,
  selectedWorktreePath,
}: WorkbenchModelInput) {
  const notifications = useTerminalStore((state) => state.notifications);
  const supervisorAlerts = useSupervisorStore((state) => state.alerts);
  const codexRequests = useCodexRequestStore((state) => state.requests);
  const rules = useWorkbenchStore((state) => state.rules);
  const followedCardIds = useWorkbenchStore((state) => state.followedCardIds);
  const followCards = useWorkbenchStore((state) => state.followCards);
  const unfollowCard = useWorkbenchStore((state) => state.unfollowCard);
  const reconcileFollowedCards = useWorkbenchStore(
    (state) => state.reconcileFollowedCards,
  );
  const now = useMinuteNow();
  const activeCardIdKey = cards.map((card) => card.id).join('\u001f');

  useEffect(() => {
    reconcileFollowedCards(activeCardIdKey ? activeCardIdKey.split('\u001f') : []);
  }, [activeCardIdKey, reconcileFollowedCards]);

  const sources = {
    notifications,
    supervisorAlerts,
    codexRequests,
    followedCardIds,
    rules,
    now,
  };
  const workbenchModel = useScopedWorkbenchModel(
    { cards, selectedProjectPath, selectedWorktreePath },
    sources,
  );
  const allProjectsWorkbenchModel = useScopedWorkbenchModel(
    { cards, selectedProjectPath: null, selectedWorktreePath: null },
    sources,
  );

  return {
    allProjectsWorkbenchModel,
    followCards,
    followedCardIds,
    unfollowCard,
    workbenchModel,
  };
}

function useScopedWorkbenchModel(
  {
    cards,
    selectedProjectPath,
    selectedWorktreePath,
  }: WorkbenchModelInput,
  {
    notifications,
    supervisorAlerts,
    codexRequests,
    followedCardIds,
    rules,
    now,
  }: WorkbenchModelSources,
) {
  const filteredCards = useMemo(
    () => filterWorkbenchCards(cards, selectedProjectPath, selectedWorktreePath),
    [cards, selectedProjectPath, selectedWorktreePath],
  );
  const allAttentionItems = useMemo(
    () =>
      deriveAttentionItems({
        cards,
        notifications,
        supervisorAlerts,
        codexRequests,
        rules,
        now,
        selectedProjectPath,
        selectedWorktreePath,
      }),
    [
      cards,
      codexRequests,
      notifications,
      now,
      rules,
      selectedProjectPath,
      selectedWorktreePath,
      supervisorAlerts,
    ],
  );
  // Stalled is a watch signal, not an action item: downstream "attention"
  // consumers (list, groups, overviews, scope counts) all work on the
  // actionable subset, while the summary gets the full set so a stalled card
  // is not counted as "running normally".
  const attentionItems = useMemo(
    () => allAttentionItems.filter((item) => item.kind !== 'stalled'),
    [allAttentionItems],
  );
  const stalledItems = useMemo(
    () => allAttentionItems.filter((item) => item.kind === 'stalled'),
    [allAttentionItems],
  );
  const groups = useMemo(
    () => deriveExecutionGroups(filteredCards, attentionItems),
    [attentionItems, filteredCards],
  );
  const summary = useMemo(
    () => deriveWorkbenchSummary(filteredCards, allAttentionItems),
    [allAttentionItems, filteredCards],
  );
  const followedCards = useMemo(
    () =>
      deriveFollowedCards(
        cards,
        followedCardIds,
        selectedProjectPath,
        selectedWorktreePath,
      ),
    [cards, followedCardIds, selectedProjectPath, selectedWorktreePath],
  );
  const projectOverviews = useMemo(
    () =>
      deriveProjectWorkbenchOverviews(
        filteredCards,
        attentionItems,
        followedCardIds,
      ),
    [attentionItems, filteredCards, followedCardIds],
  );
  const scopeAttentionCounts = useMemo(
    () => deriveWorkbenchScopeAttentionCounts(attentionItems),
    [attentionItems],
  );

  return {
    attentionItems,
    codexRequests,
    filteredCards,
    followedCardIds,
    followedCards,
    groups,
    notifications,
    now,
    projectOverviews,
    rules,
    scopeAttentionCounts,
    stalledItems,
    summary,
    supervisorAlerts,
  };
}

function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return now;
}
