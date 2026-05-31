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
        bottomBarHidden: true,
        aiExplainDefaultProvider: 'codex',
        supervisorEnabled: true,
        petConfig: {
          enabled: true,
          skin: 'cat',
          size: 64,
          position: 'bottom-right',
          notificationMode: 'both',
        },
      },
      overlayPreferences: {
        selectorMode: 'carousel',
        hotkeyA: 'CmdOrCtrl+Shift+Space',
        hotkeyB: 'CmdOrCtrl+Shift+O',
      },
    });

    expect(normalized?.terminalPreferences?.bottomBarHidden).toBe(true);
    expect(normalized?.terminalPreferences?.aiExplainDefaultProvider).toBe('codex');
    expect(normalized?.overlayPreferences?.selectorMode).toBe('carousel');
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
