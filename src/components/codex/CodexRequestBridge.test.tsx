import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CodexAppDisconnectedPayload,
  CodexAppRequestPayload,
} from '../../lib/tauri-bridge';
import { useCodexRequestStore } from '../../stores/codexRequestStore';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import { CodexRequestBridge } from './CodexRequestBridge';

type RequestHandler = (payload: CodexAppRequestPayload) => void;
type DisconnectHandler = (payload: CodexAppDisconnectedPayload) => void;

const bridgeMocks = vi.hoisted(() => ({
  onRequest: vi.fn<(callback: RequestHandler) => Promise<() => void>>(),
  onDisconnected: vi.fn<(callback: DisconnectHandler) => Promise<() => void>>(),
  requestHandlers: [] as RequestHandler[],
  disconnectHandlers: [] as DisconnectHandler[],
}));

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/tauri-bridge')>();
  return {
    ...original,
    isTauriEnv: () => true,
    codexApp: {
      ...original.codexApp,
      onRequest: bridgeMocks.onRequest,
      onDisconnected: bridgeMocks.onDisconnected,
    },
  };
});

vi.mock('../../lib/logger', () => ({
  logger: {
    warn: loggerMocks.warn,
  },
}));

function card(): TerminalCard {
  return {
    id: 'card-a',
    ptyId: 'card-a',
    projectPath: '/repo/app',
    projectName: 'app',
    terminalType: 'codex',
    codexAppThreadId: 'thread-a',
    status: 'running',
    createdAt: 1,
    lastActivity: 1,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
  };
}

function requestPayload(requestId = 'request-a'): CodexAppRequestPayload {
  return {
    requestId,
    cardId: null,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-a', command: 'npm test' },
    raw: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMocks.requestHandlers.length = 0;
  bridgeMocks.disconnectHandlers.length = 0;
  bridgeMocks.onRequest.mockImplementation((handler) => {
    bridgeMocks.requestHandlers.push(handler);
    return Promise.resolve(vi.fn());
  });
  bridgeMocks.onDisconnected.mockImplementation((handler) => {
    bridgeMocks.disconnectHandlers.push(handler);
    return Promise.resolve(vi.fn());
  });
  useCodexRequestStore.getState().reset();
  useTerminalStore.setState({
    cards: [card()],
    notifications: [],
  });
});

afterEach(() => {
  cleanup();
});

describe('CodexRequestBridge', () => {
  it('ingests once, resolves thread bindings, and pushes one attention notification', async () => {
    render(<CodexRequestBridge />);
    await waitFor(() => expect(bridgeMocks.onRequest).toHaveBeenCalledTimes(1));

    act(() => {
      bridgeMocks.requestHandlers[0](requestPayload());
      bridgeMocks.requestHandlers[0](requestPayload());
    });

    expect(useCodexRequestStore.getState().requests).toEqual([
      expect.objectContaining({
        key: 'request-a',
        cardId: 'card-a',
        threadId: 'thread-a',
        notificationId: expect.any(String),
      }),
    ]);
    expect(useTerminalStore.getState().notifications).toEqual([
      expect.objectContaining({
        cardId: 'card-a',
        kind: 'attention',
        body: 'npm test',
        routing: {
          origin: 'codex_request',
          family: 'interaction',
          episodeKey: 'interaction:card-a:0',
          fingerprint: 'request-a',
        },
      }),
    ]);
  });

  it('drops unresolved requests without creating a dead-end workbench action', async () => {
    render(<CodexRequestBridge />);
    await waitFor(() => expect(bridgeMocks.onRequest).toHaveBeenCalledTimes(1));

    act(() => {
      bridgeMocks.requestHandlers[0]({
        ...requestPayload(),
        params: { threadId: 'unknown-thread' },
      });
    });

    expect(useCodexRequestStore.getState().requests).toEqual([]);
    expect(useTerminalStore.getState().notifications).toEqual([]);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      '[CodexRequestBridge] ignored request without a resolvable card',
      { method: 'item/commandExecution/requestApproval' },
    );
  });

  it('clears executable projections and their notification on disconnect', async () => {
    render(<CodexRequestBridge />);
    await waitFor(() => expect(bridgeMocks.onDisconnected).toHaveBeenCalledTimes(1));
    act(() => bridgeMocks.requestHandlers[0](requestPayload()));
    expect(useTerminalStore.getState().notifications).toHaveLength(1);

    act(() => bridgeMocks.disconnectHandlers[0]({ message: 'server stopped' }));

    expect(useCodexRequestStore.getState()).toMatchObject({
      requests: [],
      disconnectedMessage: 'server stopped',
      disconnectRevision: 1,
    });
    expect(useTerminalStore.getState().notifications).toEqual([]);
  });

  it('unlistens registrations that resolve after cleanup', async () => {
    let resolveRequest!: (unlisten: () => void) => void;
    let resolveDisconnect!: (unlisten: () => void) => void;
    bridgeMocks.onRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    bridgeMocks.onDisconnected.mockReturnValue(
      new Promise((resolve) => {
        resolveDisconnect = resolve;
      }),
    );
    const unlistenRequest = vi.fn();
    const unlistenDisconnect = vi.fn();
    const view = render(<CodexRequestBridge />);
    view.unmount();

    await act(async () => {
      resolveRequest(unlistenRequest);
      resolveDisconnect(unlistenDisconnect);
      await Promise.resolve();
    });

    expect(unlistenRequest).toHaveBeenCalledTimes(1);
    expect(unlistenDisconnect).toHaveBeenCalledTimes(1);
  });
});
