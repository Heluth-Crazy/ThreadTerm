import { act, cleanup, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalCard } from '../../types/terminal';
import type {
  CodexAppDisconnectedPayload,
  CodexAppNotificationPayload,
  CodexAppRequestPayload,
} from '../../lib/tauri-bridge';
import { CodexChatView } from './CodexChatView';

type NotificationHandler = (payload: CodexAppNotificationPayload) => void;
type RequestHandler = (payload: CodexAppRequestPayload) => void;
type DisconnectHandler = (payload: CodexAppDisconnectedPayload) => void;

const bridgeMocks = vi.hoisted(() => ({
  openCard: vi.fn(),
  sendMessage: vi.fn(),
  respondRequest: vi.fn(),
  interrupt: vi.fn(),
  compact: vi.fn(),
  setGoal: vi.fn(),
  listSkills: vi.fn(),
  onNotification: vi.fn<(callback: NotificationHandler) => Promise<() => void>>(),
  onRequest: vi.fn<(callback: RequestHandler) => Promise<() => void>>(),
  onDisconnected: vi.fn<(callback: DisconnectHandler) => Promise<() => void>>(),
  notificationHandlers: [] as NotificationHandler[],
  requestHandlers: [] as RequestHandler[],
  disconnectHandlers: [] as DisconnectHandler[],
  notificationUnlisteners: [] as Array<ReturnType<typeof vi.fn>>,
  requestUnlisteners: [] as Array<ReturnType<typeof vi.fn>>,
  disconnectUnlisteners: [] as Array<ReturnType<typeof vi.fn>>,
}));

const storeMocks = vi.hoisted(() => ({
  bindCodexAppThread: vi.fn(),
  recordUserSubmit: vi.fn(),
  updateCardReplyPreview: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  codexApp: {
    openCard: bridgeMocks.openCard,
    sendMessage: bridgeMocks.sendMessage,
    respondRequest: bridgeMocks.respondRequest,
    interrupt: bridgeMocks.interrupt,
    compact: bridgeMocks.compact,
    setGoal: bridgeMocks.setGoal,
    listSkills: bridgeMocks.listSkills,
    onNotification: bridgeMocks.onNotification,
    onRequest: bridgeMocks.onRequest,
    onDisconnected: bridgeMocks.onDisconnected,
  },
}));

vi.mock('../../stores/terminalStore', () => ({
  useTerminalStore: (
    selector: (state: typeof storeMocks) => unknown,
  ) => selector(storeMocks),
}));

vi.mock('../../lib/logger', () => ({
  logger: {
    warn: loggerMocks.warn,
  },
}));

function makeCard(id = 'card-a'): TerminalCard {
  return {
    id,
    ptyId: id,
    projectPath: `/repo/${id}`,
    projectName: id,
    terminalType: 'codex',
    status: 'running',
    createdAt: 1_700_000_000_000,
    lastActivity: 1_700_000_000_000,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function installImmediateListeners() {
  bridgeMocks.onNotification.mockImplementation((callback) => {
    bridgeMocks.notificationHandlers.push(callback);
    const unlisten = vi.fn();
    bridgeMocks.notificationUnlisteners.push(unlisten);
    return Promise.resolve(unlisten);
  });
  bridgeMocks.onRequest.mockImplementation((callback) => {
    bridgeMocks.requestHandlers.push(callback);
    const unlisten = vi.fn();
    bridgeMocks.requestUnlisteners.push(unlisten);
    return Promise.resolve(unlisten);
  });
  bridgeMocks.onDisconnected.mockImplementation((callback) => {
    bridgeMocks.disconnectHandlers.push(callback);
    const unlisten = vi.fn();
    bridgeMocks.disconnectUnlisteners.push(unlisten);
    return Promise.resolve(unlisten);
  });
}

function installDeferredListeners() {
  const notification = deferred<() => void>();
  const request = deferred<() => void>();
  const disconnect = deferred<() => void>();

  bridgeMocks.onNotification.mockImplementation((callback) => {
    bridgeMocks.notificationHandlers.push(callback);
    return notification.promise;
  });
  bridgeMocks.onRequest.mockImplementation((callback) => {
    bridgeMocks.requestHandlers.push(callback);
    return request.promise;
  });
  bridgeMocks.onDisconnected.mockImplementation((callback) => {
    bridgeMocks.disconnectHandlers.push(callback);
    return disconnect.promise;
  });

  return { disconnect, notification, request };
}

async function waitForReady(container: HTMLElement, expectedViews = 1) {
  await waitFor(() => {
    const composers = container.querySelectorAll('textarea');
    expect(composers).toHaveLength(expectedViews);
    for (const composer of composers) {
      expect(composer).not.toBeDisabled();
    }
  });
}

function emitNotification(payload: CodexAppNotificationPayload) {
  for (const handler of bridgeMocks.notificationHandlers) handler(payload);
}

function emitRequest(payload: CodexAppRequestPayload) {
  for (const handler of bridgeMocks.requestHandlers) handler(payload);
}

function emitDisconnected(payload: CodexAppDisconnectedPayload) {
  for (const handler of bridgeMocks.disconnectHandlers) handler(payload);
}

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMocks.notificationHandlers.length = 0;
  bridgeMocks.requestHandlers.length = 0;
  bridgeMocks.disconnectHandlers.length = 0;
  bridgeMocks.notificationUnlisteners.length = 0;
  bridgeMocks.requestUnlisteners.length = 0;
  bridgeMocks.disconnectUnlisteners.length = 0;

  bridgeMocks.openCard.mockImplementation((input: { cardId: string }) =>
    Promise.resolve({
      cardId: input.cardId,
      threadId: `thread-${input.cardId}`,
      sessionId: `session-${input.cardId}`,
      threadPath: null,
      status: 'resumed',
      thread: { turns: [] },
    }),
  );
  bridgeMocks.respondRequest.mockResolvedValue(undefined);
  bridgeMocks.listSkills.mockResolvedValue({ data: [] });
  installImmediateListeners();

  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
});

describe('CodexChatView listener lifecycle', () => {
  it('unlistens each resolved listener exactly once during normal cleanup', async () => {
    const registrations = installDeferredListeners();
    const unlistenNotification = vi.fn();
    const unlistenRequest = vi.fn();
    const unlistenDisconnected = vi.fn();
    const view = render(<CodexChatView card={makeCard()} />);

    await act(async () => {
      registrations.notification.resolve(unlistenNotification);
      registrations.request.resolve(unlistenRequest);
      registrations.disconnect.resolve(unlistenDisconnected);
      await Promise.resolve();
    });

    expect(unlistenNotification).not.toHaveBeenCalled();
    expect(unlistenRequest).not.toHaveBeenCalled();
    expect(unlistenDisconnected).not.toHaveBeenCalled();

    view.unmount();
    expect(unlistenNotification).toHaveBeenCalledTimes(1);
    expect(unlistenRequest).toHaveBeenCalledTimes(1);
    expect(unlistenDisconnected).toHaveBeenCalledTimes(1);
  });

  it('immediately unlistens all three listener types when registration resolves after cleanup', async () => {
    const registrations = installDeferredListeners();
    const unlistenNotification = vi.fn();
    const unlistenRequest = vi.fn();
    const unlistenDisconnected = vi.fn();
    const view = render(<CodexChatView card={makeCard()} />);

    await waitFor(() => {
      expect(bridgeMocks.onNotification).toHaveBeenCalledTimes(1);
      expect(bridgeMocks.onRequest).toHaveBeenCalledTimes(1);
      expect(bridgeMocks.onDisconnected).toHaveBeenCalledTimes(1);
    });
    view.unmount();

    await act(async () => {
      registrations.notification.resolve(unlistenNotification);
      registrations.request.resolve(unlistenRequest);
      registrations.disconnect.resolve(unlistenDisconnected);
      await Promise.resolve();
    });

    expect(unlistenNotification).toHaveBeenCalledTimes(1);
    expect(unlistenRequest).toHaveBeenCalledTimes(1);
    expect(unlistenDisconnected).toHaveBeenCalledTimes(1);
  });

  it('handles listener registration rejection without an unhandled promise', async () => {
    bridgeMocks.onNotification.mockRejectedValue(new Error('notification listen failed'));
    bridgeMocks.onRequest.mockRejectedValue(new Error('request listen failed'));
    bridgeMocks.onDisconnected.mockRejectedValue(new Error('disconnect listen failed'));

    render(<CodexChatView card={makeCard()} />);

    await waitFor(() => expect(loggerMocks.warn).toHaveBeenCalledTimes(3));
    expect(loggerMocks.warn.mock.calls.map(([message]) => message)).toEqual(
      expect.arrayContaining([
        '[CodexChatView] failed to listen for notification',
        '[CodexChatView] failed to listen for request',
        '[CodexChatView] failed to listen for disconnect',
      ]),
    );
  });
});

describe('CodexChatView hidden event ingestion', () => {
  it('keeps delta, completion, approval, and disconnect events while hidden', async () => {
    const view = render(<CodexChatView card={makeCard()} active={false} />);
    await waitForReady(view.container);

    act(() => {
      emitNotification({
        cardId: 'card-a',
        method: 'item/agentMessage/delta',
        params: { itemId: 'hidden-item', delta: 'hidden delta' },
        raw: null,
      });
    });
    expect(within(view.container).getByText('hidden delta', { selector: 'pre' })).toBeInTheDocument();

    act(() => {
      emitNotification({
        cardId: 'card-a',
        method: 'item/completed',
        params: {
          item: { id: 'hidden-item', type: 'agentMessage', text: 'hidden complete' },
        },
        raw: null,
      });
      emitRequest({
        requestId: 'approval-hidden',
        cardId: 'card-a',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'echo hidden approval', cwd: '/repo/card-a' },
        raw: null,
      });
    });

    expect(within(view.container).getByText('hidden complete', { selector: 'pre' })).toBeInTheDocument();
    expect(within(view.container).getByText('echo hidden approval')).toBeInTheDocument();
    expect(storeMocks.updateCardReplyPreview).toHaveBeenCalledWith('card-a', 'hidden complete');

    act(() => {
      emitDisconnected({ message: 'hidden app-server disconnected' });
    });
    expect(within(view.container).getByText('hidden app-server disconnected')).toBeInTheDocument();
  });

  it('isolates identical item ids between two card views', async () => {
    const view = render(
      <>
        <section data-testid="card-a-view">
          <CodexChatView card={makeCard('card-a')} active={false} />
        </section>
        <section data-testid="card-b-view">
          <CodexChatView card={makeCard('card-b')} active={false} />
        </section>
      </>,
    );
    await waitForReady(view.container, 2);

    act(() => {
      emitNotification({
        cardId: 'card-a',
        method: 'item/agentMessage/delta',
        params: { itemId: 'shared-item-id', delta: 'only card A' },
        raw: null,
      });
      emitNotification({
        cardId: 'card-b',
        method: 'item/agentMessage/delta',
        params: { itemId: 'shared-item-id', delta: 'only card B' },
        raw: null,
      });
    });

    const cardAView = within(view.getByTestId('card-a-view'));
    const cardBView = within(view.getByTestId('card-b-view'));
    expect(cardAView.getByText('only card A', { selector: 'pre' })).toBeInTheDocument();
    expect(cardAView.queryByText('only card B')).not.toBeInTheDocument();
    expect(cardBView.getByText('only card B', { selector: 'pre' })).toBeInTheDocument();
    expect(cardBView.queryByText('only card A')).not.toBeInTheDocument();
  });

  it('preserves byte-for-byte order across 1,000 sequential deltas', async () => {
    const view = render(<CodexChatView card={makeCard()} active={false} />);
    await waitForReady(view.container);
    const deltas = Array.from({ length: 1_000 }, (_, index) => `${index.toString(36)}|`);
    const expected = deltas.join('');

    act(() => {
      for (const delta of deltas) {
        emitNotification({
          cardId: 'card-a',
          method: 'item/agentMessage/delta',
          params: { itemId: 'streamed-item', delta },
          raw: null,
        });
      }
    });

    const streamedBody = view.container.querySelector('pre');
    expect(streamedBody).not.toBeNull();
    expect(streamedBody?.textContent).toBe(expected);
  });
});
