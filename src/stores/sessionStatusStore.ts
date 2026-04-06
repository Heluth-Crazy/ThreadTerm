import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SessionRuntimeStatus =
  | 'idle'
  | 'processing'
  | 'needs_attention'
  | 'completed';

export type AttentionReason = 'error' | 'permission' | 'aborted';

export interface SessionStatusEntry {
  status: SessionRuntimeStatus;
  attentionReason?: AttentionReason;
  updatedAt: number;
  provider?: 'claude' | 'codex';
}

interface SessionStatusState {
  statuses: Record<string, SessionStatusEntry>;
  setProcessing: (sessionId: string, provider?: 'claude' | 'codex') => void;
  setCompleted: (sessionId: string) => void;
  setNeedsAttention: (sessionId: string, reason: AttentionReason) => void;
  setIdle: (sessionId: string) => void;
  removeSession: (sessionId: string) => void;
  pruneStale: (maxAgeMs?: number) => void;
  getStatus: (sessionId: string) => SessionStatusEntry;
  getProcessingSessions: () => string[];
  getAttentionSessions: () => string[];
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
              status: 'processing',
              updatedAt: Date.now(),
              provider: provider ?? state.statuses[sessionId]?.provider,
            },
          },
        })),
      setCompleted: (sessionId) =>
        set((state) => ({
          statuses: {
            ...state.statuses,
            [sessionId]: {
              ...state.statuses[sessionId],
              status: 'completed',
              attentionReason: undefined,
              updatedAt: Date.now(),
            },
          },
        })),
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
    }),
    {
      name: 'openwork-session-status',
      partialize: (state) => ({ statuses: state.statuses }),
    },
  ),
);
