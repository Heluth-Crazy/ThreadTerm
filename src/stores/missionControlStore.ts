import { create } from 'zustand';
import type { MissionControlSurfaceLocator, MissionControlSurfaceTarget } from '../lib/mission-control';

interface MissionControlFocusRequest {
  target: MissionControlSurfaceTarget;
  locator?: MissionControlSurfaceLocator;
  requestId: number;
}

interface MissionControlStoreState {
  pendingFocusRequest: MissionControlFocusRequest | null;
  requestSurfaceFocus: (target: MissionControlSurfaceTarget, locator?: MissionControlSurfaceLocator) => void;
  clearSurfaceFocus: () => void;
}

export const useMissionControlStore = create<MissionControlStoreState>((set) => ({
  pendingFocusRequest: null,
  requestSurfaceFocus: (target, locator) =>
    set({
      pendingFocusRequest: {
        target,
        locator,
        requestId: Date.now(),
      },
    }),
  clearSurfaceFocus: () => set({ pendingFocusRequest: null }),
}));
