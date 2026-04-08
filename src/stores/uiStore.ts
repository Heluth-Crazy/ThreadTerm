import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppTab } from '../types/app';

interface UiState {
  sidebarVisible: boolean;
  activePanel: AppTab;

  // UI preferences (mirrors useUiPreferences)
  autoExpandTools: boolean;
  showRawParameters: boolean;
  showThinking: boolean;
  autoScrollToBottom: boolean;
  sendByCtrlEnter: boolean;

  setSidebarVisible: (visible: boolean) => void;
  toggleSidebar: () => void;
  setActivePanel: (panel: AppTab) => void;
  setPreference: <K extends UiPreferenceKey>(key: K, value: boolean) => void;
}

type UiPreferenceKey =
  | 'autoExpandTools'
  | 'showRawParameters'
  | 'showThinking'
  | 'autoScrollToBottom'
  | 'sendByCtrlEnter';

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarVisible: true,
      activePanel: 'chat' as AppTab,

      autoExpandTools: false,
      showRawParameters: false,
      showThinking: true,
      autoScrollToBottom: true,
      sendByCtrlEnter: false,

      setSidebarVisible: (visible) => set({ sidebarVisible: visible }),
      toggleSidebar: () =>
        set((state) => ({ sidebarVisible: !state.sidebarVisible })),
      setActivePanel: (panel) => set({ activePanel: panel }),
      setPreference: (key, value) => set({ [key]: value }),
    }),
    { name: 'openwork-ui' }
  )
);
