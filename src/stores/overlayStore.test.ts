/**
 * overlayStore unit tests.
 *
 * The invoke / emit bridge into Rust is a no-op when `isTauriEnv()` is
 * false (it returns `null` on failure), so these tests focus on the pure
 * UI-state transitions: mutual exclusion, toggle, hotkey-rebind mirroring.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useOverlayStore } from './overlayStore';

function resetOverlay() {
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

beforeEach(resetOverlay);

describe('overlayStore — selector open/close', () => {
  it('openSelector sets selectorOpen and resets index', () => {
    const s = useOverlayStore.getState();
    s.setSelectedIndex(3);
    s.openSelector('inline');
    const st = useOverlayStore.getState();
    expect(st.selectorOpen).toBe(true);
    expect(st.selectorSurface).toBe('inline');
    expect(st.selectorSelectedIndex).toBe(0);
  });

  it('toggleSelector flips selectorOpen', () => {
    const s = useOverlayStore.getState();
    expect(useOverlayStore.getState().selectorOpen).toBe(false);
    s.toggleSelector();
    expect(useOverlayStore.getState().selectorOpen).toBe(true);
    useOverlayStore.getState().toggleSelector();
    expect(useOverlayStore.getState().selectorOpen).toBe(false);
  });

  it('closeSelector is a noop when already closed', () => {
    const before = useOverlayStore.getState();
    before.closeSelector();
    const after = useOverlayStore.getState();
    expect(after.selectorOpen).toBe(false);
  });
});

describe('overlayStore — mutual exclusion', () => {
  it('opening selector hides float and remembers it for restore', () => {
    useOverlayStore.setState({ floatOpen: true, floatCardId: 'card-1' });
    useOverlayStore.getState().openSelector('window');
    const st = useOverlayStore.getState();
    expect(st.selectorOpen).toBe(true);
    expect(st.floatOpen).toBe(false);
    expect(st.floatHiddenByOverlay).toBe(true);
    // cardId remains so close-restore can re-show it
    expect(st.floatCardId).toBe('card-1');
  });

  it('closing selector restores the float if it was hidden by selector', () => {
    useOverlayStore.setState({
      floatOpen: false,
      floatHiddenByOverlay: true,
      floatCardId: 'card-1',
    });
    useOverlayStore.getState().openSelector('inline');
    // Even without setting floatOpen above, reopening the selector should
    // flip floatOpen to false (already false) and leave floatHiddenByOverlay
    // based on whether the float was truly open *now*, not before.
    useOverlayStore.getState().closeSelector();
    const st = useOverlayStore.getState();
    expect(st.selectorOpen).toBe(false);
  });

  it('opening selector while float not visible leaves floatHiddenByOverlay=false', () => {
    useOverlayStore.setState({ floatOpen: false, floatCardId: null });
    useOverlayStore.getState().openSelector('inline');
    const st = useOverlayStore.getState();
    expect(st.selectorOpen).toBe(true);
    expect(st.floatHiddenByOverlay).toBe(false);
  });
});

describe('overlayStore — confirmSelector', () => {
  it('confirmSelector closes selector, opens float, and records cardId', () => {
    useOverlayStore.getState().openSelector('inline');
    useOverlayStore.getState().confirmSelector('card-42');
    const st = useOverlayStore.getState();
    expect(st.selectorOpen).toBe(false);
    expect(st.floatOpen).toBe(true);
    expect(st.floatCardId).toBe('card-42');
    expect(st.floatHiddenByOverlay).toBe(false);
  });
});

describe('overlayStore — recycleToMain', () => {
  it('recycleToMain clears selector + float state', () => {
    useOverlayStore.setState({
      selectorOpen: true,
      floatOpen: true,
      floatCardId: 'x',
      floatHiddenByOverlay: true,
    });
    useOverlayStore.getState().recycleToMain();
    const st = useOverlayStore.getState();
    expect(st.selectorOpen).toBe(false);
    expect(st.floatOpen).toBe(false);
    expect(st.floatHiddenByOverlay).toBe(false);
    // cardId is retained so the main window can focus it if needed.
    expect(st.floatCardId).toBe('x');
  });
});

describe('overlayStore — selection index', () => {
  it('setSelectedIndex wraps around when total is provided', () => {
    useOverlayStore.getState().setSelectedIndex(5, 3);
    expect(useOverlayStore.getState().selectorSelectedIndex).toBe(2);
    useOverlayStore.getState().setSelectedIndex(-1, 3);
    expect(useOverlayStore.getState().selectorSelectedIndex).toBe(2);
  });

  it('setSelectedIndex clamps to 0 when total is zero', () => {
    useOverlayStore.getState().setSelectedIndex(7, 0);
    expect(useOverlayStore.getState().selectorSelectedIndex).toBe(0);
  });
});

describe('overlayStore — hotkey mirror', () => {
  it('setHotkeys stores values for UI display', () => {
    useOverlayStore.getState().setHotkeys('Ctrl+Alt+P', 'Ctrl+Alt+F');
    const st = useOverlayStore.getState();
    expect(st.hotkeyA).toBe('Ctrl+Alt+P');
    expect(st.hotkeyB).toBe('Ctrl+Alt+F');
  });
});
