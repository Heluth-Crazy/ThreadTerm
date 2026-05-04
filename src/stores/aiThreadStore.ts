/**
 * In-memory AI thread store — keeps a small Q/A history per block id.
 *
 * Stage 6 scope:
 *   • Not persisted: threads are lost on app restart.
 *   • FIFO-capped at MAX_ENTRIES per block to bound memory.
 *   • Pending / ok / error states drive the inspector UI.
 */
import { create } from 'zustand';
import type { AiExplainProvider } from '../lib/ai/aiExplain';

export interface AiThreadEntry {
  id: string;
  role: 'user' | 'ai';
  text: string;
  provider?: AiExplainProvider;
  createdAt: number;
  state?: 'pending' | 'ok' | 'error';
}

export interface AiThread {
  blockId: string;
  entries: AiThreadEntry[];
}

interface AiThreadState {
  threads: Record<string, AiThread>;
  appendQuestion: (blockId: string, text: string) => string;
  appendAnswer: (
    blockId: string,
    text: string,
    provider: AiExplainProvider,
    state?: 'ok' | 'error',
  ) => void;
  setEntryState: (blockId: string, entryId: string, state: 'pending' | 'ok' | 'error') => void;
  clearThread: (blockId: string) => void;
}

const MAX_ENTRIES = 20;

function trim(entries: AiThreadEntry[]): AiThreadEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries;
  return entries.slice(entries.length - MAX_ENTRIES);
}

export const useAiThreadStore = create<AiThreadState>((set) => ({
  threads: {},
  appendQuestion: (blockId, text) => {
    const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => {
      const prev = s.threads[blockId]?.entries ?? [];
      return {
        threads: {
          ...s.threads,
          [blockId]: {
            blockId,
            entries: trim([
              ...prev,
              { id, role: 'user', text, createdAt: Date.now(), state: 'pending' },
            ]),
          },
        },
      };
    });
    return id;
  },
  appendAnswer: (blockId, text, provider, state = 'ok') =>
    set((s) => {
      const prev = s.threads[blockId]?.entries ?? [];
      const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return {
        threads: {
          ...s.threads,
          [blockId]: {
            blockId,
            entries: trim([
              ...prev,
              { id, role: 'ai', text, provider, createdAt: Date.now(), state },
            ]),
          },
        },
      };
    }),
  setEntryState: (blockId, entryId, state) =>
    set((s) => {
      const t = s.threads[blockId];
      if (!t) return s;
      return {
        threads: {
          ...s.threads,
          [blockId]: {
            ...t,
            entries: t.entries.map((e) => (e.id === entryId ? { ...e, state } : e)),
          },
        },
      };
    }),
  clearThread: (blockId) =>
    set((s) => {
      if (!s.threads[blockId]) return s;
      const next = { ...s.threads };
      delete next[blockId];
      return { threads: next };
    }),
}));
