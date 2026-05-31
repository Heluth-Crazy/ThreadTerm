import { describe, expect, it, vi } from 'vitest';
import {
  SETTINGS_OPEN_EVENT,
  SETTINGS_WINDOW_LABEL,
  buildSettingsWindowUrl,
  normalizeSettingsOpenPayload,
  normalizeSettingsTab,
  openSettingsWindowWithAdapters,
  type SettingsWindowAdapters,
  type SettingsWindowHandle,
} from './settingsWindow';

function createWindowHandle() {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const handle: SettingsWindowHandle = {
    show: vi.fn().mockResolvedValue(undefined),
    unminimize: vi.fn().mockResolvedValue(undefined),
    setFocus: vi.fn().mockResolvedValue(undefined),
    once: vi.fn((event, handler) => {
      handlers.set(event, handler as (event: { payload: unknown }) => void);
      return Promise.resolve(() => {});
    }),
  };

  return { handle, handlers };
}

describe('settingsWindow helpers', () => {
  it('normalizes settings tabs and builds a settings entry URL', () => {
    expect(normalizeSettingsTab('appearance')).toBe('appearance');
    expect(normalizeSettingsTab('supervisor')).toBe('supervisor');
    expect(normalizeSettingsTab('missing')).toBe('shortcuts');
    expect(buildSettingsWindowUrl('data')).toBe('settings.html?tab=data');
    expect(normalizeSettingsOpenPayload({ tab: 'appearance' })).toEqual({ tab: 'appearance' });
    expect(normalizeSettingsOpenPayload({ tab: 'nope' })).toEqual({ tab: 'shortcuts' });
  });

  it('routes to an existing settings window before focusing it', async () => {
    const { handle } = createWindowHandle();
    const adapters: SettingsWindowAdapters = {
      getExistingWindow: vi.fn().mockResolvedValue(handle),
      createWindow: vi.fn(),
      emitTo: vi.fn().mockResolvedValue(undefined),
    };

    await expect(openSettingsWindowWithAdapters('appearance', adapters)).resolves.toBe(true);

    expect(adapters.emitTo).toHaveBeenCalledWith(
      SETTINGS_WINDOW_LABEL,
      SETTINGS_OPEN_EVENT,
      { tab: 'appearance' },
    );
    expect(handle.show).toHaveBeenCalledTimes(1);
    expect(handle.unminimize).toHaveBeenCalledTimes(1);
    expect(handle.setFocus).toHaveBeenCalledTimes(1);
    expect(adapters.createWindow).not.toHaveBeenCalled();
  });

  it('creates a native settings window with the requested tab in the URL', async () => {
    const { handle, handlers } = createWindowHandle();
    const adapters: SettingsWindowAdapters = {
      getExistingWindow: vi.fn().mockResolvedValue(null),
      createWindow: vi.fn(() => handle),
      emitTo: vi.fn().mockResolvedValue(undefined),
    };

    const opened = openSettingsWindowWithAdapters('appearance', adapters);
    await Promise.resolve();
    handlers.get('tauri://created')?.({ payload: null });

    await expect(opened).resolves.toBe(true);
    expect(adapters.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'settings.html?tab=appearance',
        width: 960,
        height: 720,
        minWidth: 760,
        minHeight: 520,
        decorations: true,
        transparent: false,
      }),
    );
    expect(handle.setFocus).toHaveBeenCalledTimes(1);
  });

  it('returns false when native window creation fails', async () => {
    const { handle, handlers } = createWindowHandle();
    const adapters: SettingsWindowAdapters = {
      getExistingWindow: vi.fn().mockResolvedValue(null),
      createWindow: vi.fn(() => handle),
      emitTo: vi.fn().mockResolvedValue(undefined),
    };

    const opened = openSettingsWindowWithAdapters('appearance', adapters);
    await Promise.resolve();
    handlers.get('tauri://error')?.({ payload: 'permission denied' });

    await expect(opened).resolves.toBe(false);
  });
});
