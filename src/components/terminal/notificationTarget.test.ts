import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';
import {
  registerArchivedNotificationNavigation,
  resolveNotificationTarget,
} from './notificationTarget';

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
    pendingArchivedNotificationTarget: null,
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

async function resolveTarget(cardId: string, notificationId?: string) {
  const existing = notificationId ??
    useTerminalStore.getState().notifications.find((entry) => entry.cardId === cardId)?.id;
  const targetId = existing ?? useTerminalStore.getState().pushNotification({
    cardId,
    kind: 'completed',
    title: 'test target',
    body: '',
  }).id;
  return resolveNotificationTarget(targetId, cardId);
}

describe('resolveNotificationTarget', () => {
  it('routes unpinned cards to the grid locate channel when no card is focused', async () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 'Codex needs input', body: '' });

    expect(await resolveTarget(id)).toMatchObject({ kind: 'active', accepted: true, cardId: id });

    const state = useTerminalStore.getState();
    // Grid path: locate one-shot set, focus view untouched.
    expect(state.pendingLocateCardId).toBe(id);
    expect(state.pendingFocusCardId).toBeNull();
    expect(state.focusedCardId).toBeNull();
    expect(state.getCardById(id)?.unread).toBe(false);
    expect(useOverlayStore.getState().floatOpen).toBe(false);
  });

  it('keeps full-screen semantics when the user is already in the focus view', async () => {
    const s = useTerminalStore.getState();
    const focused = s.createCard({ projectName: 'other', projectPath: '/other', terminalType: 'shell' });
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    useTerminalStore.getState().focusCard(focused);

    expect(await resolveTarget(id)).toMatchObject({ kind: 'active', accepted: true, cardId: id });

    const state = useTerminalStore.getState();
    expect(state.pendingFocusCardId).toBe(id);
    expect(state.pendingLocateCardId).toBeNull();
  });

  it('switches to the card project when another project filter hides it', async () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    s.createCard({ projectName: 'other', projectPath: '/other', terminalType: 'shell' });
    useTerminalStore.getState().selectProject('/other');

    expect(await resolveTarget(id)).toMatchObject({ kind: 'active', accepted: true, cardId: id });

    const state = useTerminalStore.getState();
    expect(state.selectedProjectPath).toBe('/repo');
    expect(state.selectedWorktreePath).toBeNull();
    expect(state.pendingLocateCardId).toBe(id);
  });

  it('clears a worktree filter that hides the card', async () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    useTerminalStore.getState().selectWorktree('/repo', '/repo-wt/feat', 'feat');

    expect(await resolveTarget(id)).toMatchObject({ kind: 'active', accepted: true, cardId: id });

    const state = useTerminalStore.getState();
    expect(state.selectedProjectPath).toBe('/repo');
    expect(state.selectedWorktreePath).toBeNull();
    expect(state.pendingLocateCardId).toBe(id);
  });

  it('restores the exact project and worktree filter for a worktree card', async () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({
      projectName: 'repo',
      projectPath: '/repo',
      worktreePath: '/repo-wt/feat',
      branchLabel: 'feat',
      terminalType: 'codex',
    });
    useTerminalStore.getState().selectWorktree('/repo', '/repo-wt/other', 'other');

    expect(await resolveTarget(id)).toMatchObject({ kind: 'active', accepted: true, cardId: id });

    const state = useTerminalStore.getState();
    expect(state.selectedProjectPath).toBe('/repo');
    expect(state.selectedWorktreePath).toBe('/repo-wt/feat');
    expect(state.selectedWorktreeLabel).toBe('feat');
    expect(state.pendingLocateCardId).toBe(id);
  });

  it('keeps the current filters when they already show the card', async () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    useTerminalStore.getState().selectProject('/repo');

    expect(await resolveTarget(id)).toMatchObject({ kind: 'active', accepted: true, cardId: id });

    const state = useTerminalStore.getState();
    expect(state.selectedProjectPath).toBe('/repo');
    expect(state.pendingLocateCardId).toBe(id);
  });

  it('opens pinned cards in the floating terminal path', async () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'claude' });
    s.pinCard(id);
    s.pushNotification({ cardId: id, kind: 'completed', title: 'Claude replied', body: '' });

    expect(await resolveTarget(id)).toMatchObject({ kind: 'active', accepted: true, cardId: id });

    expect(useOverlayStore.getState().floatOpen).toBe(true);
    expect(useOverlayStore.getState().floatCardId).toBe(id);
    expect(useTerminalStore.getState().pendingFocusCardId).toBe(id);
    expect(useTerminalStore.getState().pendingLocateCardId).toBeNull();
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(false);
  });

  it('locates pinned cards in the main grid when lightweight mode is enabled', async () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'claude' });
    s.pinCard(id);
    useOverlayStore.setState({ lightweightMode: true });

    expect(await resolveTarget(id)).toMatchObject({ kind: 'active', accepted: true, cardId: id });

    expect(useOverlayStore.getState().floatOpen).toBe(false);
    expect(useTerminalStore.getState().pendingLocateCardId).toBe(id);
    expect(useTerminalStore.getState().focusedCardId).toBeNull();
  });

  it('returns a typed missing result and acknowledges a deleted target', async () => {
    const s = useTerminalStore.getState();
    const cardId = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    const notification = s.pushNotification({ cardId, kind: 'completed', title: 'done', body: '' });
    s.removeCard(cardId);

    expect(await resolveNotificationTarget(notification.id, cardId)).toMatchObject({
      kind: 'missing',
      accepted: false,
      notificationId: notification.id,
      cardId,
      feedbackKey: 'notifications.targetUnavailable',
    });
    expect(useTerminalStore.getState().pendingLocateCardId).toBeNull();
    expect(useTerminalStore.getState().notifications[0]?.read).toBe(true);
  });

  it('rejects an activation whose notification id is absent from the ledger', async () => {
    const cardId = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'codex',
    });

    const result = await resolveNotificationTarget('missing-notification', cardId);

    expect(result).toMatchObject({
      kind: 'stale',
      accepted: false,
      acknowledged: false,
      notificationId: 'missing-notification',
      cardId,
    });
    expect(useTerminalStore.getState().pendingLocateCardId).toBeNull();
  });

  it('rejects a notification/card mismatch without locating either card', async () => {
    const s = useTerminalStore.getState();
    const firstCardId = s.createCard({ projectName: 'first', projectPath: '/first', terminalType: 'codex' });
    const secondCardId = s.createCard({ projectName: 'second', projectPath: '/second', terminalType: 'claude' });
    const notification = s.pushNotification({
      cardId: firstCardId,
      kind: 'completed',
      title: 'first done',
      body: '',
    });

    const result = await resolveNotificationTarget(notification.id, secondCardId);

    expect(result).toMatchObject({ kind: 'stale', accepted: false, acknowledged: false });
    expect(useTerminalStore.getState().pendingLocateCardId).toBeNull();
    expect(useTerminalStore.getState().pendingFocusCardId).toBeNull();
    expect(useTerminalStore.getState().notifications[0]?.read).toBe(false);
  });

  it('allows an existing already-read notification to be located idempotently', async () => {
    const s = useTerminalStore.getState();
    const cardId = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    const notification = s.pushNotification({ cardId, kind: 'completed', title: 'done', body: '' });
    s.markNotificationRead(notification.id);

    const result = await resolveNotificationTarget(notification.id, cardId);

    expect(result).toMatchObject({ kind: 'active', accepted: true, acknowledged: true });
    expect(useTerminalStore.getState().notifications[0]?.read).toBe(true);
    expect(useTerminalStore.getState().pendingLocateCardId).toBe(cardId);
  });

  it('resolves archived targets without restoring them and waits for archive navigation', async () => {
    const s = useTerminalStore.getState();
    const cardId = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    const notification = s.pushNotification({ cardId, kind: 'completed', title: 'done', body: '' });
    s.archiveCard(cardId);
    let navigated = false;
    const unregister = registerArchivedNotificationNavigation(async (target) => {
      expect(target.notificationId).toBe(notification.id);
      expect(target.cardId).toBe(cardId);
      expect(target.card.id).toBe(cardId);
      navigated = true;
    });

    const result = await resolveNotificationTarget(notification.id, cardId);

    unregister();
    expect(result).toMatchObject({ kind: 'archived', accepted: true, notificationId: notification.id });
    expect(navigated).toBe(true);
    expect(useTerminalStore.getState().cards).toHaveLength(0);
    expect(useTerminalStore.getState().archivedCards.some((card) => card.id === cardId)).toBe(true);
    expect(useTerminalStore.getState().notifications[0]?.read).toBe(true);
  });

  it('coalesces duplicate archived activation while keeping the event scoped', async () => {
    const s = useTerminalStore.getState();
    const cardId = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    const notification = s.pushNotification({ cardId, kind: 'completed', title: 'done', body: '' });
    s.archiveCard(cardId);
    let release!: () => void;
    const navigation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const unregister = registerArchivedNotificationNavigation(navigation);

    const firstPromise = resolveNotificationTarget(notification.id, cardId);
    await Promise.resolve();
    const secondPromise = resolveNotificationTarget(notification.id, cardId);
    await Promise.resolve();
    expect(navigation).toHaveBeenCalledTimes(1);

    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    unregister();
    expect(first).toMatchObject({ kind: 'archived', accepted: true });
    expect(second).toMatchObject({ kind: 'archived', accepted: true });
    expect(useTerminalStore.getState().notifications[0]?.read).toBe(true);
  });

  it('credits a supervisor click telemetry when an alert exists for the card', async () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    s.pushNotification({ cardId: id, kind: 'attention', title: 'sudo prompt', body: '' });
    useSupervisorStore.getState().ingestAlert({
      cardId: id,
      ruleId: 'sudo-password',
      sampleText: '[sudo] password for x:',
      ts: Date.now(),
    });

    expect(await resolveTarget(id)).toMatchObject({ kind: 'active', accepted: true, cardId: id });
    expect(useSupervisorStore.getState().telemetry.clicked).toBe(1);
  });

  it('does not credit a click when no supervisor alert exists for the card', async () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 'plain', body: '' });

    expect(await resolveTarget(id)).toMatchObject({ kind: 'active', accepted: true, cardId: id });
    expect(useSupervisorStore.getState().telemetry.clicked).toBe(0);
  });

  it('returns an error and leaves the notification unread when navigation throws', async () => {
    const s = useTerminalStore.getState();
    const cardId = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    const notification = s.pushNotification({
      cardId,
      kind: 'completed',
      title: 'done',
      body: '',
    });
    const recycleToMain = vi
      .spyOn(useOverlayStore.getState(), 'recycleToMain')
      .mockImplementation(() => {
        throw new Error('navigation failed');
      });

    const result = await resolveNotificationTarget(notification.id, cardId);

    expect(result.kind).toBe('error');
    expect(useTerminalStore.getState().notifications[0]?.read).toBe(false);
    expect(useTerminalStore.getState().pendingLocateCardId).toBeNull();
    recycleToMain.mockRestore();
  });

  it('acknowledges only the clicked notification when two entries target one card', async () => {
    const s = useTerminalStore.getState();
    const cardId = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    const first = s.pushNotification({ cardId, kind: 'waiting', title: 'first', body: '' });
    const second = useTerminalStore.getState().pushNotification({
      cardId,
      kind: 'completed',
      title: 'second',
      body: '',
    });

    const result = await resolveNotificationTarget(first.id, cardId);

    expect(result).toMatchObject({ kind: 'active', accepted: true, notificationId: first.id });
    const notifications = useTerminalStore.getState().notifications;
    expect(notifications.find((entry) => entry.id === first.id)?.read).toBe(true);
    expect(notifications.find((entry) => entry.id === second.id)?.read).toBe(false);
  });

  it('keeps repeated activation of one notification id idempotent', async () => {
    const s = useTerminalStore.getState();
    const cardId = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    const notification = s.pushNotification({ cardId, kind: 'waiting', title: 'input', body: '' });

    const first = await resolveNotificationTarget(notification.id, cardId);
    const second = await resolveNotificationTarget(notification.id, cardId);

    expect(first).toMatchObject({ kind: 'active', accepted: true, notificationId: notification.id });
    expect(second).toMatchObject({ kind: 'active', accepted: true, notificationId: notification.id });
    expect(useTerminalStore.getState().notifications.filter((entry) => entry.read)).toHaveLength(1);
    expect(useTerminalStore.getState().pendingLocateCardId).toBe(cardId);
  });
});
