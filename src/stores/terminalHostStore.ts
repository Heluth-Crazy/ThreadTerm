import { create } from 'zustand';

/**
 * Runtime-only registry of daemon terminal sessions presented as workspace
 * cards inside the main window. Deliberately NOT persisted: the daemon catalog
 * is the sole authority, and reconcile re-presents desired surfaces after a
 * reconnect (design §6.1 "runtime-only card").
 */
export interface TerminalHostSurfaceState {
  handle: string;
  revision?: number;
  /** Normalized workspace path the session was created for (usually cwd). */
  workspacePath: string | null;
  presentation: 'background' | 'focused';
  status: 'attaching' | 'ready' | 'exited';
  exitCode?: number | null;
}

interface TerminalHostSurfacesStore {
  surfaces: Record<string, TerminalHostSurfaceState>;
  order: string[];
  applyPresent: (present: {
    handle: string;
    revision?: number;
    workspacePath?: string | null;
    presentation: 'background' | 'focused';
  }) => void;
  markReady: (handle: string) => void;
  markExited: (handle: string, exitCode: number | null | undefined) => void;
  remove: (handle: string) => void;
  clear: () => void;
}

export const useTerminalHostSurfacesStore = create<TerminalHostSurfacesStore>()(
  (set) => ({
    surfaces: {},
    order: [],
    applyPresent: ({ handle, revision, workspacePath, presentation }) =>
      set((state) => {
        const existing = state.surfaces[handle];
        return {
          surfaces: {
            ...state.surfaces,
            [handle]: {
              handle,
              revision: revision ?? existing?.revision,
              workspacePath:
                workspacePath === undefined
                  ? existing?.workspacePath ?? null
                  : workspacePath ?? null,
              presentation,
              // A re-present replaces the epoch and restarts the handshake.
              status: existing?.status === 'ready' ? 'attaching' : existing?.status ?? 'attaching',
              exitCode: undefined,
            },
          },
          order: existing ? state.order : [...state.order, handle],
        };
      }),
    markReady: (handle) =>
      set((state) => {
        const surface = state.surfaces[handle];
        if (!surface) return state;
        return {
          surfaces: {
            ...state.surfaces,
            [handle]: { ...surface, status: 'ready', exitCode: undefined },
          },
        };
      }),
    markExited: (handle, exitCode) =>
      set((state) => {
        const surface = state.surfaces[handle];
        if (!surface) return state;
        return {
          surfaces: {
            ...state.surfaces,
            [handle]: { ...surface, status: 'exited', exitCode: exitCode ?? null },
          },
        };
      }),
    remove: (handle) =>
      set((state) => {
        if (!state.surfaces[handle]) return state;
        const surfaces = { ...state.surfaces };
        delete surfaces[handle];
        return { surfaces, order: state.order.filter((h) => h !== handle) };
      }),
    clear: () => set({ surfaces: {}, order: [] }),
  }),
);
