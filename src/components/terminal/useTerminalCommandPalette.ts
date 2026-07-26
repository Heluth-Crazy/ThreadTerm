import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  buildCommandRegistry,
  type CommandGroup,
} from '../palette/commandRegistry';
import { openSettingsWindow, type SettingsTab } from '../../lib/settingsWindow';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import type { TerminalViewMode } from './useTerminalNavigation';

declare global {
  interface Window {
    __terminalManager?: {
      openCreate: () => void;
      closeCreate: () => void;
      setViewMode: (mode: TerminalViewMode) => void;
      openSettings: (tab?: SettingsTab) => void;
      openPalette: () => void;
      closePalette: () => void;
      requestRemoveCard: (cardId: string) => Promise<boolean>;
      requestArchiveCard: (cardId: string) => Promise<boolean>;
    };
  }
}

interface UseTerminalCommandPaletteInput {
  cards: TerminalCard[];
  focusedCardId: string | null;
  requestArchiveCard: (cardId: string) => Promise<boolean>;
  requestRemoveCard: (cardId: string) => Promise<boolean>;
  setCreateOpen: Dispatch<SetStateAction<boolean>>;
  setViewMode: Dispatch<SetStateAction<TerminalViewMode>>;
}

export function useTerminalCommandPalette({
  cards,
  focusedCardId,
  requestArchiveCard,
  requestRemoveCard,
  setCreateOpen,
  setViewMode,
}: UseTerminalCommandPaletteInput) {
  const focusCard = useTerminalStore((state) => state.focusCard);
  const selectProject = useTerminalStore((state) => state.selectProject);
  const toggleNotificationCentre = useTerminalStore(
    (state) => state.toggleNotificationCentre,
  );
  const updateCardAiIntent = useTerminalStore((state) => state.updateCardAiIntent);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialGroup, setPaletteInitialGroup] = useState<CommandGroup | null>(null);

  const handleOpenSettings = useCallback((tab: SettingsTab = 'shortcuts') => {
    void openSettingsWindow(tab).catch((error) => {
      console.warn('[settings] failed to open settings window', error);
    });
  }, []);

  const openPalette = useCallback(() => {
    setPaletteInitialGroup(null);
    setPaletteOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteInitialGroup(null);
    setPaletteOpen(false);
  }, []);

  const paletteProjects = useMemo(
    () => Array.from(new Set(cards.map((card) => card.projectPath))),
    [cards],
  );
  const paletteEntries = useMemo(() => {
    if (!paletteOpen) return [];
    return buildCommandRegistry({
      cards,
      projects: paletteProjects,
      focusedCardId,
      actions: {
        focusCard,
        selectProject,
        toggleNotificationCentre,
        updateCardAiIntent,
        openSettings: handleOpenSettings,
      },
    });
  }, [
    cards,
    focusCard,
    focusedCardId,
    handleOpenSettings,
    paletteOpen,
    paletteProjects,
    selectProject,
    toggleNotificationCentre,
    updateCardAiIntent,
  ]);

  useEffect(() => {
    window.__terminalManager = {
      openCreate: () => setCreateOpen(true),
      closeCreate: () => setCreateOpen(false),
      setViewMode: (mode) => setViewMode(mode),
      openSettings: handleOpenSettings,
      openPalette,
      closePalette,
      requestRemoveCard,
      requestArchiveCard,
    };
    return () => {
      delete window.__terminalManager;
    };
  }, [
    closePalette,
    handleOpenSettings,
    openPalette,
    requestArchiveCard,
    requestRemoveCard,
    setCreateOpen,
    setViewMode,
  ]);

  return {
    closePalette,
    handleOpenSettings,
    paletteEntries,
    paletteInitialGroup,
    paletteOpen,
  };
}
