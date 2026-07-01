import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: coreMocks.invoke,
  isTauri: coreMocks.isTauri,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

describe('isTauriEnv', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    coreMocks.isTauri.mockReturnValue(false);
    Reflect.deleteProperty(window, '__TAURI__');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('uses the official Tauri environment detector', async () => {
    coreMocks.isTauri.mockReturnValue(true);

    const { isTauriEnv } = await import('./tauri-bridge');

    expect(isTauriEnv()).toBe(true);
  });

  it('falls back to Tauri global internals for older webviews', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });

    const { isTauriEnv } = await import('./tauri-bridge');

    expect(isTauriEnv()).toBe(true);
  });

  it('falls back to the global Tauri object when enabled', async () => {
    Object.defineProperty(window, '__TAURI__', {
      value: {},
      configurable: true,
    });

    const { isTauriEnv } = await import('./tauri-bridge');

    expect(isTauriEnv()).toBe(true);
  });
});
