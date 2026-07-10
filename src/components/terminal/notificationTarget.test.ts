import { beforeEach, describe, expect, it } from 'vitest';
import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';
import { openNotificationTarget } from './notificationTarget';

function resetStores() {
  useTerminalStore.setState({
    cards: [],
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    selectedWorktreePath: null,
    selectedWorktreeLabel: null,
    pinnedCardIds: [],
    notifications: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
    pendingLocateCardId: null,
    highlightCardId: null,
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
    floatLaunchMode: 'floating',
    lightweightMode: false,
    hotkeyA: 'CmdOrCtrl+Shift+Space',
    hotkeyB: 'CmdOrCtrl+Shift+O',
  });
  useSupervisorStore.setState({
    alerts: [],
    telemetry: { triggered: 0, clicked: 0, acted: 0 },
  });
}

beforeEach(resetStores);

describe('openNotificationTarget', () => {
  it('routes unpinned cards to the grid locate channel when no card is focused', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 'Codex needs input', body: '' });

    expect(openNotificationTarget(id)).toBe(true);

    const state = useTerminalStore.getState();
    // Grid path: locate one-shot set, focus view untouched.
    expect(state.pendingLocateCardId).toBe(id);
    expect(state.pendingFocusCardId).toBeNull();
    expect(state.focusedCardId).toBeNull();
    expect(state.getCardById(id)?.unread).toBe(false);
    expect(useOverlayStore.getState().floatOpen).toBe(false);
  });

  it('keeps full-screen semantics when the user is already in the focus view', () => {
    const s = useTerminalStore.getState();
    const focused = s.createCard({ projectName: 'other', projectPath: '/other', terminalType: 'shell' });
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    useTerminalStore.getState().focusCard(focused);

    expect(openNotificationTarget(id)).toBe(true);

    const state = useTerminalStore.getState();
    expect(state.pendingFocusCardId).toBe(id);
    expect(state.pendingLocateCardId).toBeNull();
  });

  it('switches to the card project when another project filter hides it', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    s.createCard({ projectName: 'other', projectPath: '/other', terminalType: 'shell' });
    useTerminalStore.getState().selectProject('/other');

    expect(openNotificationTarget(id)).toBe(true);

    const state = useTerminalStore.getState();
    expect(state.selectedProjectPath).toBe('/repo');
    expect(state.selectedWorktreePath).toBeNull();
    expect(state.pendingLocateCardId).toBe(id);
  });

  it('clears a worktree filter that hides the card', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    useTerminalStore.getState().selectWorktree('/repo', '/repo-wt/feat', 'feat');

    expect(openNotificationTarget(id)).toBe(true);

    const state = useTerminalStore.getState();
    expect(state.selectedProjectPath).toBe('/repo');
    expect(state.selectedWorktreePath).toBeNull();
    expect(state.pendingLocateCardId).toBe(id);
  });

  it('keeps the current filters when they already show the card', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    useTerminalStore.getState().selectProject('/repo');

    expect(openNotificationTarget(id)).toBe(true);

    const state = useTerminalStore.getState();
    expect(state.selectedProjectPath).toBe('/repo');
    expect(state.pendingLocateCardId).toBe(id);
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
    expect(useTerminalStore.getState().pendingLocateCardId).toBeNull();
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(false);
  });

  it('locates pinned cards in the main grid when lightweight mode is enabled', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'claude' });
    s.pinCard(id);
    useOverlayStore.setState({ lightweightMode: true });

    expect(openNotificationTarget(id)).toBe(true);

    expect(useOverlayStore.getState().floatOpen).toBe(false);
    expect(useTerminalStore.getState().pendingLocateCardId).toBe(id);
    expect(useTerminalStore.getState().focusedCardId).toBeNull();
  });

  it('returns false for stale notification targets', () => {
    expect(openNotificationTarget('missing-card')).toBe(false);
    expect(useTerminalStore.getState().pendingLocateCardId).toBeNull();
  });

  it('credits a supervisor click telemetry when an alert exists for the card', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    s.pushNotification({ cardId: id, kind: 'attention', title: 'sudo prompt', body: '' });
    useSupervisorStore.getState().ingestAlert({
      cardId: id,
      ruleId: 'sudo-password',
      sampleText: '[sudo] password for x:',
      ts: Date.now(),
    });

    expect(openNotificationTarget(id)).toBe(true);
    expect(useSupervisorStore.getState().telemetry.clicked).toBe(1);
  });

  it('does not credit a click when no supervisor alert exists for the card', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 'plain', body: '' });

    expect(openNotificationTarget(id)).toBe(true);
    expect(useSupervisorStore.getState().telemetry.clicked).toBe(0);
  });
});
