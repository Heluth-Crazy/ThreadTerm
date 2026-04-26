import { beforeEach, describe, expect, it } from 'vitest';
import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { openNotificationTarget } from './notificationTarget';

function resetStores() {
  useTerminalStore.setState({
    cards: [],
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    pinnedCardIds: [],
    notifications: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
  });
  useOverlayStore.setState({
    selectorOpen: false,
    selectorMode: 'tile',
    selectorSurface: 'inline',
    selectorSelectedIndex: 0,
    floatOpen: false,
    floatHiddenByOverlay: false,
    floatCardId: null,
    floatWindowBounds: null,
    hotkeyA: 'CmdOrCtrl+Shift+Space',
    hotkeyB: 'CmdOrCtrl+Shift+O',
  });
}

beforeEach(resetStores);

describe('openNotificationTarget', () => {
  it('focuses unpinned cards in the main window path', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 'Codex needs input', body: '' });

    expect(openNotificationTarget(id)).toBe(true);

    expect(useTerminalStore.getState().focusedCardId).toBe(id);
    expect(useTerminalStore.getState().pendingFocusCardId).toBe(id);
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(false);
    expect(useOverlayStore.getState().floatOpen).toBe(false);
  });

  it('opens pinned cards in the floating terminal path', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'claude' });
    s.pinCard(id);
    s.pushNotification({ cardId: id, kind: 'completed', title: 'Claude replied', body: '' });

    expect(openNotificationTarget(id)).toBe(true);

    expect(useOverlayStore.getState().floatOpen).toBe(true);
    expect(useOverlayStore.getState().floatCardId).toBe(id);
    expect(useTerminalStore.getState().pendingFocusCardId).toBe(id);
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(false);
  });

  it('returns false for stale notification targets', () => {
    expect(openNotificationTarget('missing-card')).toBe(false);
  });
});
