import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalManager } from './TerminalManager';

const bridgeMocks = vi.hoisted(() => ({
  listRecent: vi.fn(),
  listAgentSessions: vi.fn(),
  syncCards: vi.fn(),
  syncState: vi.fn(),
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
    listAgentSessions: bridgeMocks.listAgentSessions,
  },
  mobileBridge: {
    syncCards: bridgeMocks.syncCards,
    syncState: bridgeMocks.syncState,
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

vi.mock('./Shell', () => ({
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

function resetStore() {
  useTerminalStore.setState({
    cards: [],
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
    bridgeMocks.listAgentSessions.mockReset();
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

  it('does not call history list APIs or import cards on mount', async () => {
    render(<TerminalManager />);

    await waitFor(() => {
      expect(bridgeMocks.invokeSupervisorEnable).toHaveBeenCalled();
    });

    expect(bridgeMocks.listRecent).not.toHaveBeenCalled();
    expect(bridgeMocks.listAgentSessions).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().cards).toHaveLength(0);
  });
});
