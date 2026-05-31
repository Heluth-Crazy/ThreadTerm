import { beforeEach, describe, expect, it } from 'vitest';
import {
  installOverlayPreferenceSync,
  overlayPreferencePatchFromPayload,
} from './overlayPreferenceSync';
import { emitSettingsChanged, SETTINGS_LOCAL_CHANGED_EVENT } from './settingsSync';
import { useOverlayStore } from '../stores/overlayStore';

function resetOverlay() {
  useOverlayStore.setState({
    selectorMode: 'tile',
    hotkeyA: 'CmdOrCtrl+Shift+Space',
    hotkeyB: 'CmdOrCtrl+Shift+O',
  });
}

beforeEach(resetOverlay);

describe('overlayPreferencePatchFromPayload', () => {
  it('extracts the overlay-preferences patch for the overlay-preferences domain', () => {
    const patch = overlayPreferencePatchFromPayload({
      domain: 'overlay-preferences',
      changedAt: 1,
      overlayPreferences: {
        selectorMode: 'carousel',
        hotkeyA: 'Ctrl+Alt+P',
        hotkeyB: 'Ctrl+Alt+F',
      },
    });

    expect(patch).toEqual({
      selectorMode: 'carousel',
      hotkeyA: 'Ctrl+Alt+P',
      hotkeyB: 'Ctrl+Alt+F',
    });
  });

  it('extracts the patch for the "all" domain when overlay preferences are present', () => {
    const patch = overlayPreferencePatchFromPayload({
      domain: 'all',
      changedAt: 2,
      overlayPreferences: {
        selectorMode: 'tile',
        hotkeyA: 'A',
        hotkeyB: 'B',
      },
    });

    expect(patch?.selectorMode).toBe('tile');
  });

  it('returns null for unrelated domains', () => {
    expect(
      overlayPreferencePatchFromPayload({ domain: 'language', changedAt: 3, language: 'en' }),
    ).toBeNull();
  });

  it('returns null when the overlay domain carries no snapshot', () => {
    expect(
      overlayPreferencePatchFromPayload({ domain: 'overlay-preferences', changedAt: 4 }),
    ).toBeNull();
  });
});

describe('installOverlayPreferenceSync', () => {
  it('applies a broadcast overlay-preference change directly into the store', async () => {
    const unlisten = installOverlayPreferenceSync();

    await emitSettingsChanged({
      domain: 'overlay-preferences',
      sourceWindow: 'settings',
      overlayPreferences: {
        selectorMode: 'carousel',
        hotkeyA: 'Ctrl+Alt+1',
        hotkeyB: 'Ctrl+Alt+2',
      },
      changedAt: 100,
    });

    const st = useOverlayStore.getState();
    expect(st.selectorMode).toBe('carousel');
    expect(st.hotkeyA).toBe('Ctrl+Alt+1');
    expect(st.hotkeyB).toBe('Ctrl+Alt+2');

    unlisten();
  });

  it('ignores non-overlay settings changes', async () => {
    const unlisten = installOverlayPreferenceSync();

    await emitSettingsChanged({
      domain: 'language',
      language: 'ja',
      sourceWindow: 'settings',
      changedAt: 101,
    });

    expect(useOverlayStore.getState().selectorMode).toBe('tile');

    unlisten();
  });

  it('does not re-emit when applying a received change (no loop)', async () => {
    // Count every settings-change event seen on the local bus. Applying a
    // received overlay change via setState must NOT dispatch another event:
    // exactly one event (the one we emit) should ever reach the listener.
    let eventCount = 0;
    const countEvents = () => {
      eventCount += 1;
    };
    window.addEventListener(SETTINGS_LOCAL_CHANGED_EVENT, countEvents);
    const unlisten = installOverlayPreferenceSync();

    await emitSettingsChanged({
      domain: 'overlay-preferences',
      sourceWindow: 'settings',
      overlayPreferences: {
        selectorMode: 'carousel',
        hotkeyA: 'A',
        hotkeyB: 'B',
      },
      changedAt: 102,
    });

    // Let any (erroneous) microtask-scheduled re-emit settle.
    await Promise.resolve();

    expect(useOverlayStore.getState().selectorMode).toBe('carousel');
    expect(eventCount).toBe(1);

    window.removeEventListener(SETTINGS_LOCAL_CHANGED_EVENT, countEvents);
    unlisten();
  });
});
