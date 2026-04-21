import { create } from 'zustand';
import type { BackgroundRun } from '../types/background-run';

type BackgroundRunInput = Omit<BackgroundRun, 'status'> & Partial<Pick<BackgroundRun, 'status'>>;
type BackgroundRunPatch = Partial<Omit<BackgroundRun, 'id'>>;

interface BackgroundRunState {
  runs: Record<string, BackgroundRun>;
  createRun: (run: BackgroundRunInput) => void;
  updateRun: (runId: string, updates: BackgroundRunPatch) => void;
  getRunByTaskId: (taskId: string) => BackgroundRun | undefined;
  getRunBySessionId: (sessionId: string) => BackgroundRun | undefined;
  updateRunForTask: (taskId: string, updates: BackgroundRunPatch) => void;
  updateRunForSession: (sessionId: string, updates: BackgroundRunPatch) => void;
  markRunCompleted: (runId: string, summary?: string) => void;
  markRunCompletedForTask: (taskId: string, summary?: string) => void;
  markRunCompletedForSession: (sessionId: string, summary?: string) => void;
  markRunFailed: (runId: string, message?: string) => void;
  markRunFailedForTask: (taskId: string, message?: string) => void;
  markRunFailedForSession: (sessionId: string, message?: string) => void;
  markRunCancelledForTask: (taskId: string, summary?: string) => void;
  markRunCancelledForSession: (sessionId: string, summary?: string) => void;
  getActiveRuns: () => BackgroundRun[];
  getRecentCompletedRuns: () => BackgroundRun[];
  getNeedsAttentionRuns: () => BackgroundRun[];
}

const ACTIVE_STATUSES: BackgroundRun['status'][] = [
  'queued',
  'starting',
  'running',
  'awaiting_input',
  'needs_attention',
];
const RECENT_VISIBLE_STATUSES: BackgroundRun['status'][] = [
  'completed',
  'failed',
  'cancelled',
];

const isActiveRun = (run: BackgroundRun): boolean => ACTIVE_STATUSES.includes(run.status);
const isRecentVisibleRun = (run: BackgroundRun): boolean => RECENT_VISIBLE_STATUSES.includes(run.status);

const needsAttention = (run: BackgroundRun): boolean =>
  run.status === 'needs_attention' ||
  run.status === 'failed' ||
  run.requiresApproval === true ||
  run.awaitingInput === true;

const sortByFinishedAtDesc = (a: BackgroundRun, b: BackgroundRun): number =>
  (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '');

const sortByRecencyDesc = (a: BackgroundRun, b: BackgroundRun): number =>
  (b.startedAt ?? b.finishedAt ?? '').localeCompare(a.startedAt ?? a.finishedAt ?? '') || b.id.localeCompare(a.id);

function findLatestRunForTask(runs: Record<string, BackgroundRun>, taskId: string): BackgroundRun | undefined {
  const matches = Object.values(runs)
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => {
      const activeDelta = Number(isActiveRun(b)) - Number(isActiveRun(a));
      if (activeDelta !== 0) {
        return activeDelta;
      }
      return sortByRecencyDesc(a, b);
    });
  return matches[0];
}

function findLatestRunForSession(runs: Record<string, BackgroundRun>, sessionId: string): BackgroundRun | undefined {
  const matches = Object.values(runs)
    .filter((run) => run.sessionId === sessionId)
    .sort(sortByRecencyDesc);
  return matches[0];
}

const nowIso = (): string => new Date().toISOString();

export const useBackgroundRunStore = create<BackgroundRunState>()((set, get) => ({
  runs: {},

  createRun: (run) =>
    set((state) => ({
      runs: {
        ...state.runs,
        [run.id]: {
          ...run,
          status: run.status ?? 'queued',
        },
      },
    })),

  updateRun: (runId, updates) =>
    set((state) => {
      const existing = state.runs[runId];
      if (!existing) return state;

      return {
        runs: {
          ...state.runs,
          [runId]: {
            ...existing,
            ...updates,
          },
        },
      };
    }),

  getRunByTaskId: (taskId) => findLatestRunForTask(get().runs, taskId),

  getRunBySessionId: (sessionId) => findLatestRunForSession(get().runs, sessionId),

  updateRunForTask: (taskId, updates) =>
    set((state) => {
      const existing = findLatestRunForTask(state.runs, taskId);
      if (!existing) return state;

      return {
        runs: {
          ...state.runs,
          [existing.id]: {
            ...existing,
            ...updates,
          },
        },
      };
    }),

  updateRunForSession: (sessionId, updates) =>
    set((state) => {
      const existing = findLatestRunForSession(state.runs, sessionId);
      if (!existing) return state;

      return {
        runs: {
          ...state.runs,
          [existing.id]: {
            ...existing,
            ...updates,
          },
        },
      };
    }),

  markRunCompleted: (runId, summary) =>
    set((state) => {
      const existing = state.runs[runId];
      if (!existing) return state;

      return {
        runs: {
          ...state.runs,
          [runId]: {
            ...existing,
            status: 'completed',
            summary: summary ?? existing.summary,
            attentionReason: undefined,
            requiresApproval: false,
            awaitingInput: false,
            finishedAt: existing.finishedAt ?? nowIso(),
          },
        },
      };
    }),

  markRunCompletedForTask: (taskId, summary) => {
    const runId = get().getRunByTaskId(taskId)?.id;
    if (!runId) return;
    get().markRunCompleted(runId, summary);
  },

  markRunCompletedForSession: (sessionId, summary) => {
    const runId = get().getRunBySessionId(sessionId)?.id;
    if (!runId) return;
    get().markRunCompleted(runId, summary);
  },

  markRunFailed: (runId, message) =>
    set((state) => {
      const existing = state.runs[runId];
      if (!existing) return state;

      return {
        runs: {
          ...state.runs,
          [runId]: {
            ...existing,
            status: 'failed',
            attentionReason: 'error',
            lastOutputExcerpt: message ?? existing.lastOutputExcerpt,
            requiresApproval: false,
            awaitingInput: false,
            finishedAt: existing.finishedAt ?? nowIso(),
          },
        },
      };
    }),

  markRunFailedForTask: (taskId, message) => {
    const runId = get().getRunByTaskId(taskId)?.id;
    if (!runId) return;
    get().markRunFailed(runId, message);
  },

  markRunFailedForSession: (sessionId, message) => {
    const runId = get().getRunBySessionId(sessionId)?.id;
    if (!runId) return;
    get().markRunFailed(runId, message);
  },

  markRunCancelledForTask: (taskId, summary) =>
    set((state) => {
      const existing = findLatestRunForTask(state.runs, taskId);
      if (!existing) return state;

      return {
        runs: {
          ...state.runs,
          [existing.id]: {
            ...existing,
            status: 'cancelled',
            summary: summary ?? existing.summary,
            attentionReason: undefined,
            requiresApproval: false,
            awaitingInput: false,
            finishedAt: existing.finishedAt ?? nowIso(),
          },
        },
      };
    }),

  markRunCancelledForSession: (sessionId, summary) =>
    set((state) => {
      const existing = findLatestRunForSession(state.runs, sessionId);
      if (!existing) return state;

      return {
        runs: {
          ...state.runs,
          [existing.id]: {
            ...existing,
            status: 'cancelled',
            summary: summary ?? existing.summary,
            attentionReason: undefined,
            requiresApproval: false,
            awaitingInput: false,
            finishedAt: existing.finishedAt ?? nowIso(),
          },
        },
      };
    }),

  getActiveRuns: () =>
    Object.values(get().runs)
      .filter(isActiveRun)
      .sort(sortByRecencyDesc),

  getRecentCompletedRuns: () =>
    Object.values(get().runs)
      .filter(isRecentVisibleRun)
      .sort(sortByFinishedAtDesc),

  getNeedsAttentionRuns: () =>
    Object.values(get().runs)
      .filter(needsAttention)
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')),
}));
