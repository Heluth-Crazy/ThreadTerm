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

describe('mobileBridge state sync', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    coreMocks.isTauri.mockReturnValue(true);
    coreMocks.invoke.mockResolvedValue(undefined);
  });

  it('sends one coherent state payload to the Rust bridge', async () => {
    const { mobileBridge } = await import('./tauri-bridge');
    const workbench = {
      generatedAt: 1,
      summary: { attention: 0, normalRunning: 0, review: 0, failed: 0 },
      attentionItems: [],
      executionGroups: [],
      rules: {
        includeWaiting: true,
        includeFailed: true,
        includeCompletedReview: true,
        stalledEnabled: true,
        stalledThresholdMinutes: 15,
        stalledExcludedCount: 0,
      },
      capabilities: {
        openTerminal: true,
        respondToStructuredRequest: false,
        updateRules: false,
        updateNotificationReadState: false,
      },
    };

    await mobileBridge.syncState([], [], workbench);

    expect(coreMocks.invoke).toHaveBeenCalledWith('bridge_sync_state', {
      cards: [],
      notifications: [],
      workbench,
    });
  });

  it('passes the complete secure tunnel URL when creating a phone pairing code', async () => {
    const { mobileBridge } = await import('./tauri-bridge');

    await mobileBridge.pairQr('https://threadterm.example.ts.net', 'full');

    expect(coreMocks.invoke).toHaveBeenCalledWith('bridge_pair_qr', {
      publicUrl: 'https://threadterm.example.ts.net',
      permission: 'full',
    });
  });
});
