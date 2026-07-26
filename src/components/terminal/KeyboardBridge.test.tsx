import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { KeyboardBridge } from './KeyboardBridge';
import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { SESSION_DOCK_KEY_EVENT } from './sessionDockKeyboard';

function dispatchKeyDown(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  useTerminalStore.setState({ dockPinned: false });
  useOverlayStore.setState({ selectorOpen: false });
  delete window.__terminalManager;
});

afterEach(() => {
  cleanup();
  delete window.__terminalManager;
  document.querySelectorAll('[data-session-dock-active]').forEach((node) => node.remove());
});

describe('KeyboardBridge', () => {
  it('toggles the session dock with Ctrl+E', () => {
    render(<KeyboardBridge />);

    const event = dispatchKeyDown({ key: 'e', ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(useTerminalStore.getState().dockPinned).toBe(true);
  });

  it('toggles the session dock with Cmd+E', () => {
    render(<KeyboardBridge />);

    dispatchKeyDown({ key: 'E', metaKey: true });

    expect(useTerminalStore.getState().dockPinned).toBe(true);
  });

  it('does not toggle the session dock when Shift or Alt is held', () => {
    render(<KeyboardBridge />);

    dispatchKeyDown({ key: 'e', ctrlKey: true, shiftKey: true });
    dispatchKeyDown({ key: 'e', ctrlKey: true, altKey: true });

    expect(useTerminalStore.getState().dockPinned).toBe(false);
  });

  it('forwards session dock navigation keys before global shortcuts', () => {
    const dock = document.createElement('section');
    dock.setAttribute('data-session-dock-active', 'true');
    document.body.appendChild(dock);
    const forwarded = vi.fn();
    window.addEventListener(SESSION_DOCK_KEY_EVENT, forwarded);
    render(<KeyboardBridge />);

    const rawNumber = dispatchKeyDown({ key: '1' });
    const ctrlNumber = dispatchKeyDown({ key: '2', ctrlKey: true });
    const arrow = dispatchKeyDown({ key: 'ArrowDown' });

    expect(rawNumber.defaultPrevented).toBe(true);
    expect(ctrlNumber.defaultPrevented).toBe(true);
    expect(arrow.defaultPrevented).toBe(true);
    expect(forwarded).toHaveBeenCalledTimes(3);
    expect(forwarded.mock.calls.map(([event]) => (event as CustomEvent).detail.key)).toEqual([
      '1',
      '2',
      'ArrowDown',
    ]);
    window.removeEventListener(SESSION_DOCK_KEY_EVENT, forwarded);
  });

  it('routes Ctrl+W through the TerminalManager removal guard', () => {
    const cardId = useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });
    useTerminalStore.getState().focusCard(cardId);
    const requestRemoveCard = vi.fn().mockResolvedValue(false);
    window.__terminalManager = {
      openCreate: vi.fn(),
      closeCreate: vi.fn(),
      setViewMode: vi.fn(),
      openSettings: vi.fn(),
      openPalette: vi.fn(),
      closePalette: vi.fn(),
      requestRemoveCard,
      requestArchiveCard: vi.fn().mockResolvedValue(false),
    };
    render(<KeyboardBridge />);

    const event = dispatchKeyDown({ key: 'w', ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(requestRemoveCard).toHaveBeenCalledWith(cardId);
    expect(useTerminalStore.getState().cards).toHaveLength(1);
  });
});
