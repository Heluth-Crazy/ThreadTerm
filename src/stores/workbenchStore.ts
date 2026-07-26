import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { WorkbenchRules } from '../lib/workbench/types';

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
  updateRules: (patch: Partial<WorkbenchRules>) => void;
  toggleStalledExclusion: (cardId: string) => void;
  resetRules: () => void;
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
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ rules: state.rules }),
      merge: (persisted, current) => {
        const persistedRules =
          persisted && typeof persisted === 'object' && 'rules' in persisted
            ? (persisted as { rules?: unknown }).rules
            : undefined;
        return {
          ...current,
          rules: normalizeWorkbenchRules(persistedRules),
        };
      },
    },
  ),
);
