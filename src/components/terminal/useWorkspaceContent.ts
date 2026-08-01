import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TFunction } from 'i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import type { GitStatusEntry } from '../../lib/tauri-bridge';
import { confirmDialog } from '../../lib/nativeDialog';
import {
  pathBasename,
  workspaceDiffTabId,
  workspaceFileTabId,
} from '../files/workspaceContentTabs';
import type { DirEntry } from '../files/fileMeta';
import type { WorkspacePanelState } from '../files/WorkspacePanel';
import {
  TERMINAL_CONTENT_TAB_ID,
  type WorkspaceContentTab,
} from './WorkspaceContentTabStrip';
import { selectMountedWorkspaceEditors } from '../files/workspaceEditorLifecycle';

interface WorkspaceContentState {
  tabs: WorkspaceContentTab[];
  activeTabId: string;
  dirtyTabIds: Record<string, boolean>;
  panelState: WorkspacePanelState;
}

const DEFAULT_WORKSPACE_PANEL_STATE: WorkspacePanelState = {
  tab: 'explorer',
  selectedFilePath: null,
  selectedChangePath: null,
};

const EMPTY_WORKSPACE_CONTENT_STATE: WorkspaceContentState = {
  tabs: [],
  activeTabId: TERMINAL_CONTENT_TAB_ID,
  dirtyTabIds: {},
  panelState: DEFAULT_WORKSPACE_PANEL_STATE,
};

function workspaceContentStateWithDefaults(
  state: WorkspaceContentState | undefined,
): WorkspaceContentState {
  return state ?? EMPTY_WORKSPACE_CONTENT_STATE;
}

function workspaceContentStateWithPanelDefaults(
  state: WorkspaceContentState,
): WorkspaceContentState {
  return {
    ...state,
    panelState: state.panelState ?? DEFAULT_WORKSPACE_PANEL_STATE,
  };
}

interface UseWorkspaceContentOptions {
  cards: TerminalCard[];
  focusedCardId: string | null;
  t: TFunction<'terminal'>;
}

export function useWorkspaceContent({
  cards,
  focusedCardId,
  t,
}: UseWorkspaceContentOptions) {
  const [workspaceContentByCardId, setWorkspaceContentByCardId] = useState<
    Record<string, WorkspaceContentState>
  >({});
  const workspaceContentByCardIdRef = useRef(workspaceContentByCardId);
  workspaceContentByCardIdRef.current = workspaceContentByCardId;

  const currentWorkspaceContent = workspaceContentStateWithPanelDefaults(
    workspaceContentStateWithDefaults(
      focusedCardId ? workspaceContentByCardId[focusedCardId] : undefined,
    ),
  );
  const workspaceContentTabs = currentWorkspaceContent.tabs;
  const activeContentTabId = currentWorkspaceContent.activeTabId;
  const dirtyWorkspaceTabIds = currentWorkspaceContent.dirtyTabIds;
  const workspacePanelState = currentWorkspaceContent.panelState;

  const activeWorkspaceTab =
    workspaceContentTabs.find((tab) => tab.id === activeContentTabId) ?? null;
  const terminalContentActive = activeContentTabId === TERMINAL_CONTENT_TAB_ID;
  const activeWorkspaceFilePath =
    activeWorkspaceTab?.kind === 'file' ? activeWorkspaceTab.path : null;
  const activeWorkspaceDiffPath =
    activeWorkspaceTab?.kind === 'diff' ? activeWorkspaceTab.change.path : null;

  const mountedWorkspaceContentViews = useMemo(() => {
    const candidates: Array<{
      cardId: string;
      tab: WorkspaceContentTab;
      dirty: boolean;
      current: boolean;
      focusedCard: boolean;
    }> = [];
    for (const card of cards) {
      const state = workspaceContentStateWithPanelDefaults(
        workspaceContentStateWithDefaults(workspaceContentByCardId[card.id]),
      );
      const focusedCard = card.id === focusedCardId;
      for (const tab of state.tabs) {
        candidates.push({
          cardId: card.id,
          tab,
          dirty: Boolean(state.dirtyTabIds[tab.id]),
          current: state.activeTabId === tab.id,
          focusedCard,
        });
      }
    }

    const { mounted } = selectMountedWorkspaceEditors(
      candidates.map((candidate) => ({
        cardId: candidate.cardId,
        tabId: candidate.tab.id,
        kind: candidate.tab.kind,
        dirty: candidate.dirty,
        current: candidate.current,
        focusedCard: candidate.focusedCard,
      })),
    );

    const mountedKeys = new Set(mounted.map((item) => `${item.cardId}::${item.tabId}`));
    return candidates
      .filter((candidate) => mountedKeys.has(`${candidate.cardId}::${candidate.tab.id}`))
      .map(({ cardId, tab }) => ({ cardId, tab }));
  }, [cards, focusedCardId, workspaceContentByCardId]);

  const updateWorkspaceContentForCard = useCallback(
    (cardId: string, updater: (state: WorkspaceContentState) => WorkspaceContentState) => {
      setWorkspaceContentByCardId((current) => {
        const previous = workspaceContentStateWithPanelDefaults(
          workspaceContentStateWithDefaults(current[cardId]),
        );
        const next = updater(previous);
        if (next === previous) return current;
        return { ...current, [cardId]: next };
      });
    },
    [],
  );

  const updateFocusedWorkspaceContent = useCallback(
    (updater: (state: WorkspaceContentState) => WorkspaceContentState) => {
      if (!focusedCardId) return;
      updateWorkspaceContentForCard(focusedCardId, updater);
    },
    [focusedCardId, updateWorkspaceContentForCard],
  );

  const setActiveContentTabId = useCallback(
    (tabId: string) => {
      updateFocusedWorkspaceContent((state) =>
        state.activeTabId === tabId ? state : { ...state, activeTabId: tabId },
      );
    },
    [updateFocusedWorkspaceContent],
  );

  useEffect(() => {
    if (
      activeContentTabId !== TERMINAL_CONTENT_TAB_ID &&
      !workspaceContentTabs.some((tab) => tab.id === activeContentTabId)
    ) {
      setActiveContentTabId(TERMINAL_CONTENT_TAB_ID);
    }
  }, [activeContentTabId, setActiveContentTabId, workspaceContentTabs]);

  const openWorkspaceFileForCard = useCallback(
    (cardId: string, rootPath: string, entry: DirEntry) => {
      const id = workspaceFileTabId(rootPath, entry.path);
      updateWorkspaceContentForCard(cardId, (state) => {
        const tabs = state.tabs.some((tab) => tab.id === id)
          ? state.tabs
          : [
              ...state.tabs,
              {
                id,
                kind: 'file' as const,
                rootPath,
                path: entry.path,
                title: pathBasename(entry.path),
              },
            ];
        return { ...state, tabs, activeTabId: id };
      });
    },
    [updateWorkspaceContentForCard],
  );

  const openWorkspaceFile = useCallback(
    (rootPath: string, entry: DirEntry) => {
      if (!focusedCardId) return;
      openWorkspaceFileForCard(focusedCardId, rootPath, entry);
    },
    [focusedCardId, openWorkspaceFileForCard],
  );

  const openWorkspaceDiff = useCallback(
    (entry: GitStatusEntry) => {
      const id = workspaceDiffTabId(entry.repositoryRoot, entry.path);
      updateFocusedWorkspaceContent((state) => {
        const existing = state.tabs.find((tab) => tab.id === id);
        const nextTab: WorkspaceContentTab = {
          id,
          kind: 'diff',
          change: entry,
          title: pathBasename(entry.path),
        };
        const tabs = existing
          ? state.tabs.map((tab) => (tab.id === id ? nextTab : tab))
          : [...state.tabs, nextTab];
        return { ...state, tabs, activeTabId: id };
      });
    },
    [updateFocusedWorkspaceContent],
  );

  const markWorkspaceTabDirty = useCallback(
    (cardId: string, tabId: string, dirty: boolean) => {
      updateWorkspaceContentForCard(cardId, (state) => {
        if (dirty) {
          if (state.dirtyTabIds[tabId]) return state;
          return { ...state, dirtyTabIds: { ...state.dirtyTabIds, [tabId]: true } };
        }
        if (!state.dirtyTabIds[tabId]) return state;
        const { [tabId]: _removed, ...rest } = state.dirtyTabIds;
        return { ...state, dirtyTabIds: rest };
      });
    },
    [updateWorkspaceContentForCard],
  );

  const closeWorkspaceTabs = useCallback(
    async (tabIds: string[], nextActiveTabId?: string) => {
      if (!focusedCardId || tabIds.length === 0) return;
      const targetIds = new Set(tabIds);
      const hasDirtyTarget = tabIds.some((tabId) => dirtyWorkspaceTabIds[tabId]);
      if (hasDirtyTarget) {
        const shouldClose = await confirmDialog(
          t('workspace.discardChangesConfirm', {
            defaultValue: 'Discard unsaved file changes?',
          }),
          t('workspace.unsavedTitle', { defaultValue: 'Unsaved changes' }),
        );
        if (!shouldClose) return;
      }

      setWorkspaceContentByCardId((current) => {
        const state = workspaceContentStateWithPanelDefaults(
          workspaceContentStateWithDefaults(current[focusedCardId]),
        );
        const tabs = state.tabs.filter((tab) => !targetIds.has(tab.id));
        const dirtyTabIds = Object.fromEntries(
          Object.entries(state.dirtyTabIds).filter(([tabId]) => !targetIds.has(tabId)),
        );
        const activeTabId =
          nextActiveTabId ??
          (targetIds.has(state.activeTabId) ? TERMINAL_CONTENT_TAB_ID : state.activeTabId);
        return {
          ...current,
          [focusedCardId]: {
            ...state,
            tabs,
            dirtyTabIds,
            activeTabId,
          },
        };
      });
    },
    [dirtyWorkspaceTabIds, focusedCardId, t],
  );

  const closeWorkspaceTab = useCallback(
    (tabId: string) => closeWorkspaceTabs([tabId]),
    [closeWorkspaceTabs],
  );

  const closeAllWorkspaceTabs = useCallback(
    () => closeWorkspaceTabs(workspaceContentTabs.map((tab) => tab.id)),
    [closeWorkspaceTabs, workspaceContentTabs],
  );

  const closeOtherWorkspaceTabs = useCallback(
    (tabId: string) =>
      closeWorkspaceTabs(
        workspaceContentTabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id),
        tabId,
      ),
    [closeWorkspaceTabs, workspaceContentTabs],
  );

  const requestCardExit = useCallback(
    async (cardId: string, action: 'remove' | 'archive'): Promise<boolean> => {
      const cardExists = useTerminalStore
        .getState()
        .cards
        .some((card) => card.id === cardId);
      if (!cardExists) return false;

      const workspaceState = workspaceContentByCardIdRef.current[cardId];
      const hasDirtyDraft = Object.values(workspaceState?.dirtyTabIds ?? {}).some(Boolean);
      if (hasDirtyDraft) {
        const shouldDiscard = await confirmDialog(
          t('workspace.discardChangesConfirm', {
            defaultValue: 'Discard unsaved file changes?',
          }),
          t('workspace.unsavedTitle', { defaultValue: 'Unsaved changes' }),
        );
        if (!shouldDiscard) return false;
      }

      const store = useTerminalStore.getState();
      if (!store.cards.some((card) => card.id === cardId)) return false;

      setWorkspaceContentByCardId((current) => {
        if (!(cardId in current)) return current;
        const { [cardId]: _discarded, ...next } = current;
        workspaceContentByCardIdRef.current = next;
        return next;
      });

      if (action === 'archive') {
        store.archiveCard(cardId);
      } else {
        store.removeCard(cardId);
      }
      return true;
    },
    [t],
  );

  const requestCardWorkspaceReset = useCallback(
    async (cardId: string): Promise<boolean> => {
      const cardExists = useTerminalStore
        .getState()
        .cards
        .some((card) => card.id === cardId);
      if (!cardExists) return false;

      const workspaceState = workspaceContentByCardIdRef.current[cardId];
      const hasDirtyDraft = Object.values(
        workspaceState?.dirtyTabIds ?? {},
      ).some(Boolean);
      if (hasDirtyDraft) {
        const shouldDiscard = await confirmDialog(
          t('workspace.discardChangesConfirm', {
            defaultValue: 'Discard unsaved file changes?',
          }),
          t('workspace.unsavedTitle', { defaultValue: 'Unsaved changes' }),
        );
        if (!shouldDiscard) return false;
      }
      if (
        !useTerminalStore
          .getState()
          .cards
          .some((card) => card.id === cardId)
      ) {
        return false;
      }

      setWorkspaceContentByCardId((current) => {
        if (!(cardId in current)) return current;
        const { [cardId]: _discarded, ...next } = current;
        workspaceContentByCardIdRef.current = next;
        return next;
      });
      return true;
    },
    [t],
  );

  const requestRemoveCard = useCallback(
    (cardId: string) => requestCardExit(cardId, 'remove'),
    [requestCardExit],
  );

  const requestArchiveCard = useCallback(
    (cardId: string) => requestCardExit(cardId, 'archive'),
    [requestCardExit],
  );

  const handleWorkspacePanelStateChange = useCallback(
    (panelState: WorkspacePanelState) => {
      updateFocusedWorkspaceContent((state) => ({ ...state, panelState }));
    },
    [updateFocusedWorkspaceContent],
  );

  const activateTerminalForCard = useCallback((cardId: string) => {
    setWorkspaceContentByCardId((current) => {
      const state = workspaceContentStateWithPanelDefaults(
        workspaceContentStateWithDefaults(current[cardId]),
      );
      if (state.activeTabId === TERMINAL_CONTENT_TAB_ID) return current;
      return {
        ...current,
        [cardId]: {
          ...state,
          activeTabId: TERMINAL_CONTENT_TAB_ID,
        },
      };
    });
  }, []);

  return {
    workspaceContentTabs,
    activeContentTabId,
    dirtyWorkspaceTabIds,
    workspacePanelState,
    terminalContentActive,
    activeWorkspaceFilePath,
    activeWorkspaceDiffPath,
    mountedWorkspaceContentViews,
    setActiveContentTabId,
    openWorkspaceFileForCard,
    openWorkspaceFile,
    openWorkspaceDiff,
    markWorkspaceTabDirty,
    closeWorkspaceTab,
    closeAllWorkspaceTabs,
    closeOtherWorkspaceTabs,
    requestRemoveCard,
    requestArchiveCard,
    requestCardWorkspaceReset,
    handleWorkspacePanelStateChange,
    activateTerminalForCard,
  };
}
