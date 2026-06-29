import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { KeyboardBridge } from './KeyboardBridge';
import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';

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
});

afterEach(() => {
  cleanup();
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
});
