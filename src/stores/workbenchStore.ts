import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { WorkbenchRules } from '../lib/workbench/types';
import { managedStateStorage } from '../lib/managedState';
import {
  moveProjectPath,
  normalizeProjectOrder,
  projectOrdersEqual,
  reconcileProjectPathOrder,
} from '../lib/workbench/projectOrder';

export const DEFAULT_WORKBENCH_RULES: WorkbenchRules = {
  includeWaiting: true,
  includeFailed: true,
  includeCompletedReview: true,
  stalledEnabled: false,
  stalledThresholdMinutes: 30,
  stalledExcludedCardIds: [],
};

interface WorkbenchStore {
  rules: WorkbenchRules;
  followedCardIds: string[];
  projectOrder: string[];
  followCards: (cardIds: readonly string[]) => void;
  unfollowCard: (cardId: string) => void;
  reconcileFollowedCards: (validCardIds: readonly string[]) => void;
  reconcileProjectOrder: (validProjectPaths: readonly string[]) => void;
  moveProject: (
    activeProjectPath: string,
    overProjectPath: string,
    visibleProjectPaths: readonly string[],
  ) => void;
  updateRules: (patch: Partial<WorkbenchRules>) => void;
  toggleStalledExclusion: (cardId: string) => void;
  resetRules: () => void;
}

export function normalizeFollowedCardIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (cardId): cardId is string =>
          typeof cardId === 'string' && cardId.trim().length > 0,
      ),
    ),
  );
}

export function normalizeWorkbenchRules(value: unknown): WorkbenchRules {
  const candidate =
    value && typeof value === 'object' ? (value as Partial<WorkbenchRules>) : {};
  const threshold = Number(candidate.stalledThresholdMinutes);
  const excluded = Array.isArray(candidate.stalledExcludedCardIds)
    ? Array.from(
        new Set(
          candidate.stalledExcludedCardIds.filter(
            (cardId): cardId is string => typeof cardId === 'string' && cardId.trim().length > 0,
          ),
        ),
      )
    : [];
  return {
    includeWaiting:
      typeof candidate.includeWaiting === 'boolean'
        ? candidate.includeWaiting
        : DEFAULT_WORKBENCH_RULES.includeWaiting,
    includeFailed:
      typeof candidate.includeFailed === 'boolean'
        ? candidate.includeFailed
        : DEFAULT_WORKBENCH_RULES.includeFailed,
    includeCompletedReview:
      typeof candidate.includeCompletedReview === 'boolean'
        ? candidate.includeCompletedReview
        : DEFAULT_WORKBENCH_RULES.includeCompletedReview,
    stalledEnabled:
      typeof candidate.stalledEnabled === 'boolean'
        ? candidate.stalledEnabled
        : DEFAULT_WORKBENCH_RULES.stalledEnabled,
    stalledThresholdMinutes: Number.isFinite(threshold)
      ? Math.min(1_440, Math.max(5, Math.round(threshold)))
      : DEFAULT_WORKBENCH_RULES.stalledThresholdMinutes,
    stalledExcludedCardIds: excluded,
  };
}

export const useWorkbenchStore = create<WorkbenchStore>()(
  persist(
    (set) => ({
      rules: { ...DEFAULT_WORKBENCH_RULES },
      followedCardIds: [],
      projectOrder: [],
      followCards: (cardIds) =>
        set((state) => {
          const incoming = normalizeFollowedCardIds(cardIds);
          if (incoming.length === 0) return state;
          const incomingIds = new Set(incoming);
          return {
            followedCardIds: [
              ...incoming,
              ...state.followedCardIds.filter((cardId) => !incomingIds.has(cardId)),
            ],
          };
        }),
      unfollowCard: (cardId) =>
        set((state) => ({
          followedCardIds: state.followedCardIds.filter((id) => id !== cardId),
        })),
      reconcileFollowedCards: (validCardIds) =>
        set((state) => {
          const validIds = new Set(validCardIds);
          const followedCardIds = state.followedCardIds.filter((cardId) =>
            validIds.has(cardId),
          );
          if (followedCardIds.length === state.followedCardIds.length) return state;
          return { followedCardIds };
        }),
      reconcileProjectOrder: (validProjectPaths) =>
        set((state) => {
          const projectOrder = reconcileProjectPathOrder(
            state.projectOrder,
            validProjectPaths,
          );
          if (projectOrdersEqual(projectOrder, state.projectOrder)) return state;
          return { projectOrder };
        }),
      moveProject: (
        activeProjectPath,
        overProjectPath,
        visibleProjectPaths,
      ) =>
        set((state) => {
          const projectOrder = moveProjectPath(
            state.projectOrder,
            activeProjectPath,
            overProjectPath,
            visibleProjectPaths,
          );
          if (projectOrdersEqual(projectOrder, state.projectOrder)) return state;
          return { projectOrder };
        }),
      updateRules: (patch) =>
        set((state) => ({
          rules: normalizeWorkbenchRules({ ...state.rules, ...patch }),
        })),
      toggleStalledExclusion: (cardId) =>
        set((state) => ({
          rules: {
            ...state.rules,
            stalledExcludedCardIds: state.rules.stalledExcludedCardIds.includes(cardId)
              ? state.rules.stalledExcludedCardIds.filter((id) => id !== cardId)
              : [...state.rules.stalledExcludedCardIds, cardId],
          },
        })),
      resetRules: () => set({ rules: { ...DEFAULT_WORKBENCH_RULES } }),
    }),
    {
      name: 'threadterm-workbench-store',
      version: 3,
      storage: createJSONStorage(() => managedStateStorage),
      migrate: (persistedState) => persistedState,
      partialize: (state) => ({
        rules: state.rules,
        followedCardIds: state.followedCardIds,
        projectOrder: state.projectOrder,
      }),
      merge: (persisted, current) => {
        const persistedRules =
          persisted && typeof persisted === 'object' && 'rules' in persisted
            ? (persisted as { rules?: unknown }).rules
            : undefined;
        const persistedFollowedCardIds =
          persisted && typeof persisted === 'object' && 'followedCardIds' in persisted
            ? (persisted as { followedCardIds?: unknown }).followedCardIds
            : undefined;
        const persistedProjectOrder =
          persisted && typeof persisted === 'object' && 'projectOrder' in persisted
            ? (persisted as { projectOrder?: unknown }).projectOrder
            : undefined;
        return {
          ...current,
          rules: normalizeWorkbenchRules(persistedRules),
          followedCardIds: normalizeFollowedCardIds(persistedFollowedCardIds),
          projectOrder: normalizeProjectOrder(persistedProjectOrder),
        };
      },
    },
  ),
);
