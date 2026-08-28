import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';
import { useCodexRequestStore } from '../../stores/codexRequestStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import type { NotificationEntry, TerminalCard } from '../../types/terminal';
import { useWorkbenchModel } from './useWorkbenchModel';

const NOW = 1_800_000_000_000;

function card(): TerminalCard {
  return {
    id: 'card-1',
    ptyId: 'card-1',
    projectPath: '/repo',
    projectName: 'Repo',
    terminalType: 'codex',
    status: 'completed',
    createdAt: NOW - 10_000,
    lastActivity: NOW,
    lastOutput: '',
    lastReplyPreview: 'Finished result',
    messageCount: 1,
    events: [],
    unread: true,
  };
}

function completedNotification(id: string, at: number): NotificationEntry {
  return {
    id,
    cardId: 'card-1',
    kind: 'completed',
    at,
    title: 'Result ready',
    body: id,
    read: false,
  };
}

beforeEach(() => {
  localStorage.clear();
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    notifications: [],
    selectedProjectPath: null,
  });
  useWorkbenchStore.getState().resetRules();
  useWorkbenchStore.setState({
    followedCardIds: [],
    projectOrder: [],
    pinnedProjects: [],
    ignoredAttention: [],
  });
  useSupervisorStore.getState().clearAlerts();
  useCodexRequestStore.getState().reset();
});

describe('useWorkbenchModel result acknowledgement', () => {
  it('acknowledges only the viewed completion and suppresses its state fallback', async () => {
    const activeCard = card();
    const older = completedNotification('completed-older', NOW - 2_000);
    const viewed = completedNotification('completed-viewed', NOW - 1_000);
    useTerminalStore.setState({
      cards: [activeCard],
      notifications: [older, viewed],
    });

    const { result } = renderHook(() =>
      useWorkbenchModel({
        cards: [activeCard],
        archivedCards: [],
        selectedProjectPath: null,
        selectedWorktreePath: null,
      }),
    );

    const item = result.current.workbenchModel.attentionItems.find(
      (candidate) => candidate.sourceId === viewed.id,
    );
    expect(item).toBeDefined();

    act(() => result.current.acknowledgeAttention(item!));

    expect(
      useTerminalStore.getState().notifications.map(({ id, read }) => ({ id, read })),
    ).toEqual([
      { id: older.id, read: false },
      { id: viewed.id, read: true },
    ]);
    expect(useWorkbenchStore.getState().ignoredAttention).toEqual([
      expect.objectContaining({
        cardId: activeCard.id,
        kind: 'review',
        sourceId: viewed.id,
      }),
    ]);
    await waitFor(() => {
      expect(result.current.workbenchModel.attentionItems).toEqual([]);
    });
  });
});
