import { useEffect, useMemo, useState } from 'react';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';
import {
  deriveAttentionItems,
  deriveWorkbenchSummary,
  filterWorkbenchCards,
} from '../../lib/workbench/deriveAttentionItems';
import { deriveExecutionGroups } from '../../lib/workbench/deriveExecutionGroups';
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
  const now = useMinuteNow();

  const sources = {
    notifications,
    supervisorAlerts,
    codexRequests,
    rules,
    now,
  };
  const workbenchModel = useScopedWorkbenchModel(
    { cards, selectedProjectPath, selectedWorktreePath },
    sources,
  );
  const mobileWorkbenchModel = useScopedWorkbenchModel(
    { cards, selectedProjectPath: null, selectedWorktreePath: null },
    sources,
  );

  return { mobileWorkbenchModel, workbenchModel };
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
    rules,
    now,
  }: WorkbenchModelSources,
) {
  const filteredCards = useMemo(
    () => filterWorkbenchCards(cards, selectedProjectPath, selectedWorktreePath),
    [cards, selectedProjectPath, selectedWorktreePath],
  );
  const attentionItems = useMemo(
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
  const groups = useMemo(
    () => deriveExecutionGroups(filteredCards, attentionItems),
    [attentionItems, filteredCards],
  );
  const summary = useMemo(
    () => deriveWorkbenchSummary(filteredCards, attentionItems),
    [attentionItems, filteredCards],
  );

  return {
    attentionItems,
    codexRequests,
    filteredCards,
    groups,
    notifications,
    now,
    rules,
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
