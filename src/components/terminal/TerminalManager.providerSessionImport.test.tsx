import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalManager } from './TerminalManager';

const bridgeMocks = vi.hoisted(() => ({
  listRecent: vi.fn(),
  syncCards: vi.fn(),
  onSpawnCard: vi.fn(),
  onActivateCard: vi.fn(),
  onRemoveCard: vi.fn(),
  resolveSpawn: vi.fn(),
  resolveActivate: vi.fn(),
  resolveClose: vi.fn(),
  invokeSupervisorEnable: vi.fn(),
  subscribeSupervisorAlert: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  providerSessions: {
    listRecent: bridgeMocks.listRecent,
  },
  mobileBridge: {
    syncCards: bridgeMocks.syncCards,
    onSpawnCard: bridgeMocks.onSpawnCard,
    onActivateCard: bridgeMocks.onActivateCard,
    onRemoveCard: bridgeMocks.onRemoveCard,
    resolveSpawn: bridgeMocks.resolveSpawn,
    resolveActivate: bridgeMocks.resolveActivate,
    resolveClose: bridgeMocks.resolveClose,
  },
  tokenStats: {
    compute: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    onProgress: () => Promise.resolve(() => {}),
    onDone: () => Promise.resolve(() => {}),
    onError: () => Promise.resolve(() => {}),
  },
  invokeSupervisorEnable: bridgeMocks.invokeSupervisorEnable,
  subscribeSupervisorAlert: bridgeMocks.subscribeSupervisorAlert,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'provider-import-test' }),
}));

vi.mock('../Shell', () => ({
  default: () => <div data-testid="mock-shell" />,
}));

vi.mock('./TerminalView', () => ({
  TerminalView: () => <div data-testid="mock-terminal-view" />,
}));

vi.mock('./CardGrid', () => ({
  CardGrid: () => <div data-testid="mock-card-grid" />,
}));

vi.mock('./CreateTerminalDialog', () => ({
  CreateTerminalDialog: () => null,
}));

vi.mock('./ProjectSidebar', () => ({
  ProjectSidebar: () => <aside data-testid="mock-project-sidebar" />,
}));

vi.mock('../Settings', () => ({
  default: () => null,
}));

vi.mock('../../lib/workflows/useWorkflows', () => ({
  useWorkflows: () => ({
    workflows: [],
    reload: vi.fn(),
  }),
}));

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    blocks: {},
    collapsedBlockIds: [],
    selectedBlockId: {},
    bookmarks: [],
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    pinnedCardIds: [],
    notifications: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
    osNotificationsEnabled: true,
    supervisorEnabled: false,
  });
}

describe('TerminalManager provider session startup import', () => {
  beforeEach(() => {
    resetStore();
    bridgeMocks.listRecent.mockReset();
    bridgeMocks.syncCards.mockReset();
    bridgeMocks.onSpawnCard.mockReset();
    bridgeMocks.onActivateCard.mockReset();
    bridgeMocks.onRemoveCard.mockReset();
    bridgeMocks.resolveSpawn.mockReset();
    bridgeMocks.resolveActivate.mockReset();
    bridgeMocks.resolveClose.mockReset();
    bridgeMocks.invokeSupervisorEnable.mockResolvedValue(undefined);
    bridgeMocks.subscribeSupervisorAlert.mockResolvedValue(() => {});
  });

  it('imports existing provider sessions as idle bound cards without focusing them', async () => {
    bridgeMocks.listRecent.mockResolvedValue([
      {
        id: 'codex-session-1',
        provider: 'codex',
        projectPath: '/repo/app',
        updatedAt: 1234,
      },
    ]);

    render(<TerminalManager />);

    await waitFor(() => {
      expect(bridgeMocks.listRecent).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(
        useTerminalStore
          .getState()
          .cards.some((card) => card.providerSessionId === 'codex-session-1'),
      ).toBe(true);
    });

    const state = useTerminalStore.getState();
    const card = state.cards.find(
      (candidate) => candidate.providerSessionId === 'codex-session-1',
    );
    expect(card).toMatchObject({
      projectName: 'app',
      projectPath: '/repo/app',
      terminalType: 'codex',
      providerSessionState: 'bound',
      status: 'idle',
    });
    expect(state.focusedCardId).toBeNull();
    expect(state.lastActiveCardId).toBeNull();
    expect(bridgeMocks.syncCards).not.toHaveBeenCalled();
  });
});
