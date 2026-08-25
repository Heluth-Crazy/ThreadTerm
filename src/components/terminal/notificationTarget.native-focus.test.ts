import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriEnv: vi.fn(() => true),
}));

vi.mock('../../lib/tauri-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri-bridge')>();
  return {
    ...actual,
    invoke: tauriMocks.invoke,
    isTauriEnv: tauriMocks.isTauriEnv,
  };
});

import { useTerminalStore } from '../../stores/terminalStore';
import { resolveNotificationTarget } from './notificationTarget';

beforeEach(() => {
  vi.clearAllMocks();
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    notifications: [],
    pendingFocusCardId: null,
    pendingLocateCardId: null,
    pendingArchivedNotificationTarget: null,
  });
});

describe('resolveNotificationTarget native focus boundary', () => {
  it('keeps the clicked notification unread when native focus rejects', async () => {
    tauriMocks.invoke.mockRejectedValueOnce(new Error('window focus rejected'));
    const store = useTerminalStore.getState();
    const cardId = store.createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'codex',
    });
    const notification = useTerminalStore.getState().pushNotification({
      cardId,
      kind: 'completed',
      title: 'done',
      body: '',
    });

    const result = await resolveNotificationTarget(notification.id, cardId);

    expect(result).toMatchObject({
      kind: 'error',
      accepted: false,
      acknowledged: false,
      notificationId: notification.id,
      cardId,
    });
    expect(useTerminalStore.getState().notifications[0]?.read).toBe(false);
    expect(useTerminalStore.getState().pendingLocateCardId).toBeNull();
  });
});
