import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';
import {
  deriveAttentionItems,
  deriveWorkbenchSummary,
  filterWorkbenchCards,
} from '../../lib/workbench/deriveAttentionItems';
import { notificationIdsAcknowledgedByIgnore } from '../../lib/workbench/ignoreAttention';
import type { AttentionItem } from '../../lib/workbench/types';
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
  archivedCards: readonly TerminalCard[];
  selectedProjectPath: string | null;
  selectedWorktreePath: string | null;
}

interface ScopedWorkbenchModelInput {
  cards: readonly TerminalCard[];
  followableCards: readonly TerminalCard[];
  selectedProjectPath: string | null;
  selectedWorktreePath: string | null;
}

interface WorkbenchModelSources {
  notifications: ReturnType<typeof useTerminalStore.getState>['notifications'];
  supervisorAlerts: ReturnType<typeof useSupervisorStore.getState>['alerts'];
  codexRequests: ReturnType<typeof useCodexRequestStore.getState>['requests'];
  followedCardIds: ReturnType<typeof useWorkbenchStore.getState>['followedCardIds'];
  ignoredAttention: ReturnType<typeof useWorkbenchStore.getState>['ignoredAttention'];
  rules: ReturnType<typeof useWorkbenchStore.getState>['rules'];
  now: number;
}

export function useWorkbenchModel({
  cards,
  archivedCards,
  selectedProjectPath,
  selectedWorktreePath,
}: WorkbenchModelInput) {
  const notifications = useTerminalStore((state) => state.notifications);
  const supervisorAlerts = useSupervisorStore((state) => state.alerts);
  const codexRequests = useCodexRequestStore((state) => state.requests);
  const rules = useWorkbenchStore((state) => state.rules);
  const followedCardIds = useWorkbenchStore((state) => state.followedCardIds);
  const ignoredAttention = useWorkbenchStore(
    (state) => state.ignoredAttention,
  );
  const followCards = useWorkbenchStore((state) => state.followCards);
  const unfollowCard = useWorkbenchStore((state) => state.unfollowCard);
  const ignoreAttentionInStore = useWorkbenchStore(
    (state) => state.ignoreAttention,
  );
  const reconcileFollowedCards = useWorkbenchStore(
    (state) => state.reconcileFollowedCards,
  );
  const reconcileIgnoredAttention = useWorkbenchStore(
    (state) => state.reconcileIgnoredAttention,
  );
  const reconcilePinnedProjects = useWorkbenchStore(
    (state) => state.reconcilePinnedProjects,
  );
  const markNotificationRead = useTerminalStore(
    (state) => state.markNotificationRead,
  );
  const now = useMinuteNow();
  const retainedCards = useMemo(
    () => [...cards, ...archivedCards],
    [archivedCards, cards],
  );
  const activeCardIdKey = cards.map((card) => card.id).join('\u001f');
  const retainedCardIdKey = retainedCards.map((card) => card.id).join('\u001f');

  useEffect(() => {
    const validCardIds = retainedCardIdKey ? retainedCardIdKey.split('\u001f') : [];
    reconcileFollowedCards(validCardIds);
    reconcileIgnoredAttention(activeCardIdKey ? activeCardIdKey.split('\u001f') : []);
  }, [activeCardIdKey, reconcileFollowedCards, reconcileIgnoredAttention, retainedCardIdKey]);

  const ignoreAttention = useCallback(
    (item: AttentionItem) => {
      ignoreAttentionInStore(item);
      const notificationIds = notificationIdsAcknowledgedByIgnore(
        item,
        useTerminalStore.getState().notifications,
      );
      for (const notificationId of notificationIds) {
        markNotificationRead(notificationId);
      }
    },
    [ignoreAttentionInStore, markNotificationRead],
  );

  const acknowledgeAttention = useCallback(
    (item: AttentionItem) => {
      ignoreAttentionInStore(item);
      if (item.sourceKind === 'notification') {
        markNotificationRead(item.sourceId);
      }
    },
    [ignoreAttentionInStore, markNotificationRead],
  );

  const sources = {
    notifications,
    supervisorAlerts,
    codexRequests,
    followedCardIds,
    ignoredAttention,
    rules,
    now,
  };
  const workbenchModel = useScopedWorkbenchModel(
    { cards, followableCards: retainedCards, selectedProjectPath, selectedWorktreePath },
    sources,
  );
  const allProjectsWorkbenchModel = useScopedWorkbenchModel(
    { cards, followableCards: retainedCards, selectedProjectPath: null, selectedWorktreePath: null },
    sources,
  );

  const projectPathKey = allProjectsWorkbenchModel.projectOverviews
    .map((project) => project.projectPath)
    .join('');
  useEffect(() => {
    const validProjectPaths = projectPathKey ? projectPathKey.split('') : [];
    reconcilePinnedProjects(validProjectPaths);
  }, [projectPathKey, reconcilePinnedProjects]);

  return {
    acknowledgeAttention,
    allProjectsWorkbenchModel,
    followCards,
    followedCardIds,
    ignoreAttention,
    unfollowCard,
    workbenchModel,
  };
}

function useScopedWorkbenchModel(
  {
    cards,
    followableCards,
    selectedProjectPath,
    selectedWorktreePath,
  }: ScopedWorkbenchModelInput,
  {
    notifications,
    supervisorAlerts,
    codexRequests,
    followedCardIds,
    ignoredAttention,
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
        ignoredAttention,
      }),
    [
      cards,
      codexRequests,
      ignoredAttention,
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
        followableCards,
        followedCardIds,
        selectedProjectPath,
        selectedWorktreePath,
      ),
    [followableCards, followedCardIds, selectedProjectPath, selectedWorktreePath],
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
