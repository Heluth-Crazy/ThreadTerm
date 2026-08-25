import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PtyCreateSessionV2Request,
  PtyCreateSessionV2Result,
  PtyStartupSnapshot,
} from '../types/ptyStartup';

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: coreMocks.invoke,
  isTauri: coreMocks.isTauri,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMocks.listen,
}));

describe('isTauriEnv', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    eventMocks.listen.mockReset();
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
    eventMocks.listen.mockReset();
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

describe('pty launch contract', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    eventMocks.listen.mockReset();
    coreMocks.isTauri.mockReturnValue(true);
    coreMocks.invoke.mockResolvedValue('pty-1');
  });

  it('keeps the legacy interactive create payload unchanged', async () => {
    const { pty } = await import('./tauri-bridge');

    await pty.create('pty-1', '/tmp/project', 24, 80, 'codex');

    expect(coreMocks.invoke).toHaveBeenCalledWith('pty_create', {
      id: 'pty-1',
      workingDir: '/tmp/project',
      rows: 24,
      cols: 80,
      provider: 'codex',
    });
  });

  it('adds an optional one-shot descriptor without changing launch-attempt fields', async () => {
    const { pty } = await import('./tauri-bridge');
    const launch = {
      executionMode: 'oneShot' as const,
      command: 'printf one-shot',
    };

    await pty.createWithLaunchAttempt(
      'pty-1',
      '/tmp/project',
      24,
      80,
      undefined,
      'attempt-1',
      launch,
    );

    expect(coreMocks.invoke).toHaveBeenCalledWith('pty_create', {
      id: 'pty-1',
      workingDir: '/tmp/project',
      rows: 24,
      cols: 80,
      provider: undefined,
      launchAttemptId: 'attempt-1',
      launch,
    });
  });

  it('invokes v2 create with the request nested exactly and returns the backend result', async () => {
    const { pty } = await import('./tauri-bridge');
    const request: PtyCreateSessionV2Request = {
      id: 'pty-1',
      workingDir: 'C:/project',
      rows: 24,
      cols: 80,
      launchAttemptId: 'attempt-1',
      startup: {
        kind: 'provider',
        provider: 'codex',
        command: 'codex --new',
        cardId: 'card-1',
        action: 'start',
        sideEffectPlan: { kind: 'discover' },
      },
    };
    const startup: PtyStartupSnapshot = {
      ptyId: 'pty-1',
      generation: 'generation-1',
      revision: 1,
      state: 'waiting',
    };
    const result: PtyCreateSessionV2Result = {
      ptyId: 'pty-1',
      generation: 'generation-1',
      disposition: 'created',
      shellFamily: 'posix',
      descriptorDisposition: 'accepted',
      startup,
    };
    coreMocks.invoke.mockResolvedValueOnce(result);

    await expect(pty.createSessionV2(request)).resolves.toBe(result);

    expect(coreMocks.invoke).toHaveBeenCalledTimes(1);
    expect(coreMocks.invoke).toHaveBeenCalledWith('pty_create_session_v2', { request });
    expect(coreMocks.invoke.mock.calls[0][1]).toEqual({ request });
  });

  it('queries startup state with the exact generation payload and passes through snapshots', async () => {
    const { pty } = await import('./tauri-bridge');
    const snapshot: PtyStartupSnapshot = {
      ptyId: 'pty-1',
      generation: 'generation-1',
      revision: 3,
      state: 'sent',
      trigger: 'marker',
    };
    coreMocks.invoke.mockResolvedValueOnce(snapshot);

    await expect(pty.getStartupState('pty-1', 'generation-1')).resolves.toBe(snapshot);

    expect(coreMocks.invoke).toHaveBeenCalledWith('pty_get_startup_state', {
      ptyId: 'pty-1',
      generation: 'generation-1',
    });
  });

  it('forwards startup-state payloads and exposes the listener unsubscribe function', async () => {
    const { pty } = await import('./tauri-bridge');
    const snapshot: PtyStartupSnapshot = {
      ptyId: 'pty-1',
      generation: 'generation-1',
      revision: 4,
      state: 'timedOut',
      trigger: 'timeout',
    };
    const unsubscribe = vi.fn();
    let handler: ((event: { payload: PtyStartupSnapshot }) => void) | undefined;
    eventMocks.listen.mockImplementationOnce(
      (_event: string, listener: (event: { payload: PtyStartupSnapshot }) => void) => {
        handler = listener;
        return Promise.resolve(unsubscribe);
      },
    );
    const callback = vi.fn();

    const unlisten = await pty.onStartupState(callback);

    expect(eventMocks.listen).toHaveBeenCalledWith('pty-startup-state', expect.any(Function));
    handler?.({ payload: snapshot });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(snapshot);
    expect(unlisten).toBe(unsubscribe);
    unlisten();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
