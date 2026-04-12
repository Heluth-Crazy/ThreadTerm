import { create } from 'zustand';
import type { LoopState } from '../lib/tauri-bridge';

interface LoopStore {
  loops: Record<string, LoopState>;
  updateLoop: (loopId: string, state: Partial<LoopState>) => void;
  removeLoop: (loopId: string) => void;
}

export const useLoopStore = create<LoopStore>((set) => ({
  loops: {},
  updateLoop: (loopId, state) =>
    set((prev) => ({
      loops: {
        ...prev.loops,
        [loopId]: { ...prev.loops[loopId], ...state, loopId } as LoopState,
      },
    })),
  removeLoop: (loopId) =>
    set((prev) => {
      const { [loopId]: _, ...rest } = prev.loops;
      return { loops: rest };
    }),
}));
