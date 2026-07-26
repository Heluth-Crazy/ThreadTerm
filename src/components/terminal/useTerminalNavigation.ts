import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import type {
  PrimaryView,
  WorkbenchPanelState,
} from '../../lib/workbench/types';
import type { RightSurface } from './useRightSurfaceStack';

export type TerminalViewMode = 'grid' | 'focus';

interface UseTerminalNavigationInput {
  cards: readonly TerminalCard[];
  focusedCard: TerminalCard | undefined;
  focusedCardId: string | null;
  primaryView: PrimaryView;
  terminalsVisible: boolean;
  activateTerminalForCard: (cardId: string) => void;
  closeRightSurface: (surface: RightSurface) => void;
  mountCardInBackground: (cardId: string) => void;
  openRightSurface: (surface: RightSurface) => void;
  setMobileViewActive: Dispatch<SetStateAction<boolean>>;
  setPrimaryView: Dispatch<SetStateAction<PrimaryView>>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setViewMode: Dispatch<SetStateAction<TerminalViewMode>>;
  setWorkbenchPanel: Dispatch<SetStateAction<WorkbenchPanelState | null>>;
}

export function useTerminalNavigation({
  cards,
  focusedCard,
  focusedCardId,
  primaryView,
  terminalsVisible,
  activateTerminalForCard,
  closeRightSurface,
  mountCardInBackground,
  openRightSurface,
  setMobileViewActive,
  setPrimaryView,
  setSidebarOpen,
  setViewMode,
  setWorkbenchPanel,
}: UseTerminalNavigationInput) {
  const focusCard = useTerminalStore((state) => state.focusCard);
  const pendingFocusCardId = useTerminalStore((state) => state.pendingFocusCardId);
  const setPendingFocusCardId = useTerminalStore((state) => state.setPendingFocusCardId);
  const pendingLocateCardId = useTerminalStore((state) => state.pendingLocateCardId);
  const setPendingLocateCardId = useTerminalStore((state) => state.setPendingLocateCardId);
  const highlightCard = useTerminalStore((state) => state.highlightCard);
  const returnPrimaryViewRef = useRef<PrimaryView>('workbench');
  const previousFocusedCardIdRef = useRef<string | null>(null);

  const focusMountedCard = useCallback(
    (cardId: string) => {
      mountCardInBackground(cardId);
      focusCard(cardId);
      setViewMode('focus');
    },
    [focusCard, mountCardInBackground, setViewMode],
  );

  useEffect(() => {
    if (focusedCardId && focusedCard) {
      if (!previousFocusedCardIdRef.current) {
        returnPrimaryViewRef.current = primaryView;
      }
      setViewMode('focus');
    } else {
      setViewMode('grid');
    }
    previousFocusedCardIdRef.current = focusedCardId;
  }, [focusedCardId, focusedCard, primaryView, setViewMode]);

  useEffect(() => {
    if (!pendingFocusCardId) return;
    if (!cards.some((card) => card.id === pendingFocusCardId)) {
      setPendingFocusCardId(null);
      return;
    }
    returnPrimaryViewRef.current = primaryView;
    setWorkbenchPanel(null);
    closeRightSurface('workbench');
    setMobileViewActive(false);
    focusMountedCard(pendingFocusCardId);
    setPendingFocusCardId(null);
  }, [
    cards,
    closeRightSurface,
    focusMountedCard,
    pendingFocusCardId,
    primaryView,
    setMobileViewActive,
    setPendingFocusCardId,
    setWorkbenchPanel,
  ]);

  useEffect(() => {
    if (!pendingLocateCardId) return;
    if (cards.some((card) => card.id === pendingLocateCardId)) {
      if (terminalsVisible) {
        highlightCard(pendingLocateCardId);
      } else {
        returnPrimaryViewRef.current = primaryView;
        setWorkbenchPanel(null);
        closeRightSurface('workbench');
        setMobileViewActive(false);
        focusMountedCard(pendingLocateCardId);
      }
    }
    setPendingLocateCardId(null);
  }, [
    cards,
    closeRightSurface,
    focusMountedCard,
    highlightCard,
    pendingLocateCardId,
    primaryView,
    setMobileViewActive,
    setPendingLocateCardId,
    setWorkbenchPanel,
    terminalsVisible,
  ]);

  const handleOpenTerminal = useCallback(
    (cardId: string) => {
      returnPrimaryViewRef.current = primaryView;
      setWorkbenchPanel(null);
      closeRightSurface('workbench');
      setMobileViewActive(false);
      focusMountedCard(cardId);
    },
    [
      closeRightSurface,
      focusMountedCard,
      primaryView,
      setMobileViewActive,
      setWorkbenchPanel,
    ],
  );

  const handleBackToGrid = useCallback(() => {
    focusCard(null);
    setPrimaryView(returnPrimaryViewRef.current);
    setMobileViewActive(false);
    setViewMode('grid');
  }, [focusCard, setMobileViewActive, setPrimaryView, setViewMode]);

  const handleSelectPrimaryView = useCallback(
    (view: PrimaryView) => {
      returnPrimaryViewRef.current = view;
      setPrimaryView(view);
      setMobileViewActive(false);
      setWorkbenchPanel(null);
      closeRightSurface('workbench');
      setSidebarOpen(false);
      if (focusedCardId) focusCard(null);
      setViewMode('grid');
    },
    [
      closeRightSurface,
      focusCard,
      focusedCardId,
      setMobileViewActive,
      setPrimaryView,
      setSidebarOpen,
      setViewMode,
      setWorkbenchPanel,
    ],
  );

  const handleOpenMobileAccess = useCallback(() => {
    setMobileViewActive(true);
    setWorkbenchPanel(null);
    closeRightSurface('workbench');
    if (focusedCardId) focusCard(null);
    setViewMode('grid');
  }, [
    closeRightSurface,
    focusCard,
    focusedCardId,
    setMobileViewActive,
    setViewMode,
    setWorkbenchPanel,
  ]);

  const handleOpenWorkbenchPanel = useCallback(
    (panel: WorkbenchPanelState) => {
      setWorkbenchPanel(panel);
      openRightSurface('workbench');
    },
    [openRightSurface, setWorkbenchPanel],
  );

  const handleCloseWorkbenchPanel = useCallback(() => {
    setWorkbenchPanel(null);
    closeRightSurface('workbench');
  }, [closeRightSurface, setWorkbenchPanel]);

  const handleSelectSessionDockCard = useCallback(
    (cardId: string) => {
      focusMountedCard(cardId);
      activateTerminalForCard(cardId);
    },
    [activateTerminalForCard, focusMountedCard],
  );

  return {
    focusMountedCard,
    handleBackToGrid,
    handleCloseWorkbenchPanel,
    handleOpenMobileAccess,
    handleOpenTerminal,
    handleOpenWorkbenchPanel,
    handleSelectPrimaryView,
    handleSelectSessionDockCard,
  };
}
