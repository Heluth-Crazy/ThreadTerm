import { describe, expect, it, vi } from 'vitest';
import {
  createSettingsChangedPayload,
  emitSettingsChanged,
  listenSettingsChanged,
  normalizeSettingsChangedPayload,
} from './settingsSync';

describe('settingsSync', () => {
  it('normalizes valid settings change payloads', () => {
    const payload = createSettingsChangedPayload({
      domain: 'language',
      language: 'en',
      sourceWindow: 'settings',
      changedAt: 123,
    });

    expect(normalizeSettingsChangedPayload(payload)).toEqual(payload);
  });

  it('rejects unknown domains', () => {
    expect(normalizeSettingsChangedPayload({ domain: 'unknown' })).toBeNull();
  });

  it('keeps terminal and overlay snapshots in the normalized payload', () => {
    const normalized = normalizeSettingsChangedPayload({
      domain: 'all',
      changedAt: 456,
      terminalPreferences: {
        supervisorEnabled: true,
        osNotificationsEnabled: true,
      },
      overlayPreferences: {
        selectorMode: 'carousel',
        hotkeyA: 'CmdOrCtrl+Shift+Space',
        hotkeyB: 'CmdOrCtrl+Shift+O',
        lightweightMode: true,
      },
    });

    expect(normalized?.terminalPreferences?.supervisorEnabled).toBe(true);
    expect(normalized?.terminalPreferences?.osNotificationsEnabled).toBe(true);
    expect(normalized?.overlayPreferences?.selectorMode).toBe('carousel');
    expect(normalized?.overlayPreferences?.lightweightMode).toBe(true);
  });

  it('defaults missing overlay lightweight mode to false for older payloads', () => {
    const normalized = normalizeSettingsChangedPayload({
      domain: 'overlay-preferences',
      changedAt: 457,
      overlayPreferences: {
        selectorMode: 'tile',
        hotkeyA: 'A',
        hotkeyB: 'B',
      },
    });

    expect(normalized?.overlayPreferences?.lightweightMode).toBe(false);
  });

  it('delivers browser-local settings events for non-Tauri tests and previews', async () => {
    const handler = vi.fn();
    const unlisten = listenSettingsChanged(handler);

    await emitSettingsChanged({
      domain: 'language',
      language: 'ja',
      sourceWindow: 'settings',
      changedAt: 789,
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'language',
        language: 'ja',
        changedAt: 789,
      }),
    );

    unlisten();
  });
});
