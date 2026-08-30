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

  it('acknowledges only the opened waiting notification and suppresses its state fallback', async () => {
    const activeCard = { ...card(), status: 'waiting' as const };
    const older: NotificationEntry = {
      ...completedNotification('waiting-older', NOW - 2_000),
      kind: 'waiting',
    };
    const viewed: NotificationEntry = {
      ...completedNotification('waiting-viewed', NOW - 1_000),
      kind: 'waiting',
    };
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
    expect(item).toMatchObject({
      kind: 'waiting_input',
      sourceKind: 'notification',
    });

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
        kind: 'waiting_input',
        sourceId: viewed.id,
      }),
    ]);
    await waitFor(() => {
      expect(result.current.workbenchModel.attentionItems).toEqual([]);
    });
  });

  it('keeps an acknowledged waiting state hidden across later output until it re-enters waiting', async () => {
    const initialCard: TerminalCard = {
      ...card(),
      status: 'waiting',
      lastActivity: NOW - 2_000,
      events: [{ at: NOW - 3_000, kind: 'status', summary: 'waiting' }],
    };
    const { result, rerender } = renderHook(
      ({ activeCard }) =>
        useWorkbenchModel({
          cards: [activeCard],
          archivedCards: [],
          selectedProjectPath: null,
          selectedWorktreePath: null,
        }),
      { initialProps: { activeCard: initialCard } },
    );

    const item = result.current.workbenchModel.attentionItems[0];
    expect(item).toMatchObject({
      kind: 'waiting_input',
      sourceKind: 'terminal_state',
      occurredAt: NOW - 3_000,
    });
    act(() => result.current.acknowledgeAttention(item!));

    const outputAdvanced = {
      ...initialCard,
      lastActivity: NOW + 10_000,
      lastOutput: 'renderer redraw after acknowledgement',
    };
    rerender({ activeCard: outputAdvanced });
    await waitFor(() => {
      expect(result.current.workbenchModel.attentionItems).toEqual([]);
    });

    rerender({
      activeCard: {
        ...outputAdvanced,
        events: [
          ...outputAdvanced.events,
          { at: NOW + 11_000, kind: 'status', summary: 'running' },
          { at: NOW + 12_000, kind: 'status', summary: 'waiting' },
        ],
      },
    });
    await waitFor(() => {
      expect(result.current.workbenchModel.attentionItems).toEqual([
        expect.objectContaining({
          kind: 'waiting_input',
          occurredAt: NOW + 12_000,
        }),
      ]);
    });
  });
});
