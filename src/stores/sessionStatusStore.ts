import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Phase 1 migration boundary: this store is now the runtime session-status
// projection only. Approval / permission state lives in attentionStore.

export type SessionRuntimeStatus =
  | 'idle'
  | 'processing'
  | 'needs_attention'
  | 'completed';

export type AttentionReason = 'error' | 'permission' | 'aborted';

export interface SessionRuntimeProjection {
  taskId?: string;
  taskTitle?: string;
  taskStatus?: string;
  taskRole?: string;
  taskExecutionStrategy?: string;
  projectPath?: string;
  worktreePath?: string;
}

export interface SessionStatusEntry extends SessionRuntimeProjection {
  status: SessionRuntimeStatus;
  attentionReason?: AttentionReason;
  updatedAt: number;
  provider?: 'claude' | 'codex';
}

export interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
}

interface SessionStatusState {
  statuses: Record<string, SessionStatusEntry>;
  setProcessing: (sessionId: string, provider?: 'claude' | 'codex') => void;
  setCompleted: (sessionId: string, options?: { force?: boolean }) => void;
  setNeedsAttention: (sessionId: string, reason: AttentionReason) => void;
  setIdle: (sessionId: string) => void;
  removeSession: (sessionId: string) => void;
  pruneStale: (maxAgeMs?: number) => void;
  getStatus: (sessionId: string) => SessionStatusEntry;
  getProcessingSessions: () => string[];
  getAttentionSessions: () => string[];
  setRuntimeProjection: (sessionId: string, projection: SessionRuntimeProjection) => void;
  rebindSession: (fromSessionId: string, toSessionId: string, provider?: 'claude' | 'codex') => void;
}

const DEFAULT_ENTRY: SessionStatusEntry = { status: 'idle', updatedAt: 0 };
const PRUNE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const useSessionStatusStore = create<SessionStatusState>()(
  persist(
    (set, get) => ({
      statuses: {},
      setProcessing: (sessionId, provider) =>
        set((state) => ({
          statuses: {
            ...state.statuses,
            [sessionId]: {
              ...state.statuses[sessionId],
              status: 'processing',
              updatedAt: Date.now(),
              provider: provider ?? state.statuses[sessionId]?.provider,
            },
          },
        })),
      setCompleted: (sessionId, options) =>
        set((state) => {
          const current = state.statuses[sessionId];
          // Don't overwrite needs_attention — user must explicitly handle it
          if (current?.status === 'needs_attention' && !options?.force) return state;
          return {
            statuses: {
              ...state.statuses,
              [sessionId]: {
                ...current,
                status: 'completed',
                attentionReason: undefined,
                updatedAt: Date.now(),
              },
            },
          };
        }),
      setNeedsAttention: (sessionId, reason) =>
        set((state) => ({
          statuses: {
            ...state.statuses,
            [sessionId]: {
              ...state.statuses[sessionId],
              status: 'needs_attention',
              attentionReason: reason,
              updatedAt: Date.now(),
            },
          },
        })),
      setIdle: (sessionId) =>
        set((state) => ({
          statuses: {
            ...state.statuses,
            [sessionId]: {
              ...state.statuses[sessionId],
              status: 'idle',
              attentionReason: undefined,
              updatedAt: Date.now(),
            },
          },
        })),
      removeSession: (sessionId) =>
        set((state) => {
          const { [sessionId]: _, ...rest } = state.statuses;
          return { statuses: rest };
        }),
      pruneStale: (maxAgeMs = PRUNE_MAX_AGE_MS) =>
        set((state) => {
          const now = Date.now();
          const pruned: Record<string, SessionStatusEntry> = {};
          for (const [id, entry] of Object.entries(state.statuses)) {
            if (
              entry.status === 'processing' ||
              entry.status === 'needs_attention' ||
              now - entry.updatedAt < maxAgeMs
            ) {
              pruned[id] = entry;
            }
          }
          return { statuses: pruned };
        }),
      getStatus: (sessionId) => get().statuses[sessionId] ?? DEFAULT_ENTRY,
      getProcessingSessions: () =>
        Object.entries(get().statuses)
          .filter(([, e]) => e.status === 'processing')
          .map(([id]) => id),
      getAttentionSessions: () =>
        Object.entries(get().statuses)
          .filter(([, e]) => e.status === 'needs_attention')
          .map(([id]) => id),
      setRuntimeProjection: (sessionId, projection) =>
        set((state) => {
          const current = state.statuses[sessionId] ?? DEFAULT_ENTRY;
          const nextEntry = {
            ...current,
            ...projection,
            updatedAt: current.updatedAt || Date.now(),
          };
          const isUnchanged =
            current.taskId === nextEntry.taskId &&
            current.taskTitle === nextEntry.taskTitle &&
            current.taskStatus === nextEntry.taskStatus &&
            current.taskRole === nextEntry.taskRole &&
            current.taskExecutionStrategy === nextEntry.taskExecutionStrategy &&
            current.projectPath === nextEntry.projectPath &&
            current.worktreePath === nextEntry.worktreePath;
          if (isUnchanged) {
            return state;
          }
          return {
            statuses: {
              ...state.statuses,
              [sessionId]: nextEntry,
            },
          };
        }),
      rebindSession: (fromSessionId, toSessionId, provider) =>
        set((state) => {
          const previous = state.statuses[fromSessionId];
          const nextExisting = state.statuses[toSessionId];
          const nextStatuses = { ...state.statuses };
          if (previous) {
            delete nextStatuses[fromSessionId];
          }

          nextStatuses[toSessionId] = {
            ...previous,
            ...nextExisting,
            provider: provider ?? nextExisting?.provider ?? previous?.provider,
            updatedAt: Date.now(),
            status: nextExisting?.status ?? previous?.status ?? 'idle',
          };

          return { statuses: nextStatuses };
        }),
    }),
    {
      name: 'openwork-session-status',
      partialize: (state) => ({ statuses: state.statuses }),
    },
  ),
);
