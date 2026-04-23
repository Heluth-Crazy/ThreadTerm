import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalStore } from './terminalStore';

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    focusedCardId: null,
    lastActiveCardId: null,
    switcherVisible: false,
    switcherSelectedIndex: 0,
    notifications: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
  });
}

beforeEach(resetStore);

describe('terminalStore — card lifecycle', () => {
  it('creates a card with default metadata', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });

    const card = useTerminalStore.getState().getCardById(id);
    expect(card).toBeDefined();
    expect(card?.projectName).toBe('foo');
    expect(card?.status).toBe('idle');
    expect(card?.events).toHaveLength(1);
    expect(card?.events[0]?.kind).toBe('created');
  });

  it('updateCardOutput strips ANSI and retains only the tail', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });
    // 3 kB of ascii + colour codes
    const chunk = '\x1b[31mhello\x1b[0m\n'.repeat(200);
    useTerminalStore.getState().updateCardOutput(id, chunk);
    const out = useTerminalStore.getState().getCardById(id)?.lastOutput ?? '';
    expect(out.includes('\x1b')).toBe(false);
    expect(out.length).toBeLessThanOrEqual(2000);
  });

  it('removeCard drops related notifications', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });
    s.pushNotification({
      cardId: id,
      kind: 'waiting',
      title: 'needs input',
      body: 'y/n?',
    });
    expect(useTerminalStore.getState().notifications).toHaveLength(1);
    useTerminalStore.getState().removeCard(id);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
  });
});

describe('terminalStore — focus & switching', () => {
  it('focusCard remembers previous focus as lastActive', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });

    useTerminalStore.getState().focusCard(a);
    useTerminalStore.getState().focusCard(b);

    expect(useTerminalStore.getState().focusedCardId).toBe(b);
    expect(useTerminalStore.getState().lastActiveCardId).toBe(a);
  });

  it('switchToLast returns to the previous card', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });

    useTerminalStore.getState().focusCard(a);
    useTerminalStore.getState().focusCard(b);
    useTerminalStore.getState().switchToLast();
    expect(useTerminalStore.getState().focusedCardId).toBe(a);
  });

  it('nextCard / prevCard cycle through cards', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });
    const c = s.createCard({ projectName: 'c', projectPath: '/c', terminalType: 'shell' });

    useTerminalStore.getState().focusCard(a);
    useTerminalStore.getState().nextCard();
    expect(useTerminalStore.getState().focusedCardId).toBe(b);
    useTerminalStore.getState().nextCard();
    expect(useTerminalStore.getState().focusedCardId).toBe(c);
    useTerminalStore.getState().nextCard();
    expect(useTerminalStore.getState().focusedCardId).toBe(a);
    useTerminalStore.getState().prevCard();
    expect(useTerminalStore.getState().focusedCardId).toBe(c);
  });

  it('jumpToIndex ignores out-of-range indices', () => {
    const s = useTerminalStore.getState();
    s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    useTerminalStore.getState().jumpToIndex(5);
    expect(useTerminalStore.getState().focusedCardId).toBeNull();
  });
});

describe('terminalStore — switcher', () => {
  it('opens and confirms switcher selection', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });
    useTerminalStore.getState().focusCard(a);

    useTerminalStore.getState().openSwitcher();
    expect(useTerminalStore.getState().switcherVisible).toBe(true);
    expect(useTerminalStore.getState().switcherSelectedIndex).toBe(0);

    useTerminalStore.getState().setSwitcherSelectedIndex(1);
    useTerminalStore.getState().confirmSwitcher();

    expect(useTerminalStore.getState().switcherVisible).toBe(false);
    expect(useTerminalStore.getState().focusedCardId).toBe(b);
  });

  it('wraps switcher index modulo card count', () => {
    const s = useTerminalStore.getState();
    s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });
    useTerminalStore.getState().setSwitcherSelectedIndex(5);
    expect(useTerminalStore.getState().switcherSelectedIndex).toBe(1);
    useTerminalStore.getState().setSwitcherSelectedIndex(-1);
    expect(useTerminalStore.getState().switcherSelectedIndex).toBe(1);
  });
});

describe('terminalStore — notifications', () => {
  it('push flags the card as unread', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 't', body: 'b' });
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(true);
  });

  it('focusing a card clears its unread flag', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 't', body: 'b' });
    useTerminalStore.getState().focusCard(id);
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(false);
  });

  it('markAllNotificationsRead does exactly that', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 't', body: 'b' });
    s.pushNotification({ cardId: id, kind: 'failed', title: 't2', body: 'b2' });
    useTerminalStore.getState().markAllNotificationsRead();
    expect(useTerminalStore.getState().getUnreadCount()).toBe(0);
  });
});
