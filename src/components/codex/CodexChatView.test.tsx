import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalCard } from '../../types/terminal';
import type { CodexAppNotificationPayload } from '../../lib/tauri-bridge';
import { useCodexRequestStore } from '../../stores/codexRequestStore';
import { CodexChatView } from './CodexChatView';

type NotificationHandler = (payload: CodexAppNotificationPayload) => void;

const bridgeMocks = vi.hoisted(() => ({
  openCard: vi.fn(),
  sendMessage: vi.fn(),
  respondRequest: vi.fn(),
  interrupt: vi.fn(),
  compact: vi.fn(),
  setGoal: vi.fn(),
  listSkills: vi.fn(),
  onNotification: vi.fn<(callback: NotificationHandler) => Promise<() => void>>(),
  notificationHandlers: [] as NotificationHandler[],
  notificationUnlisteners: [] as Array<ReturnType<typeof vi.fn>>,
}));

const storeMocks = vi.hoisted(() => ({
  bindCodexAppThread: vi.fn(),
  recordUserSubmit: vi.fn(),
  updateCardReplyPreview: vi.fn(),
  removeNotification: vi.fn(),
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
}

function installDeferredListeners() {
  const notification = deferred<() => void>();

  bridgeMocks.onNotification.mockImplementation((callback) => {
    bridgeMocks.notificationHandlers.push(callback);
    return notification.promise;
  });

  return { notification };
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

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMocks.notificationHandlers.length = 0;
  bridgeMocks.notificationUnlisteners.length = 0;
  useCodexRequestStore.getState().reset();

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
  it('opens a card once when its newly bound thread is persisted', async () => {
    const card = makeCard();
    const view = render(<CodexChatView card={card} />);
    await waitForReady(view.container);

    await act(async () => {
      view.rerender(
        <CodexChatView
          card={{
            ...card,
            codexAppThreadId: 'thread-card-a',
            codexAppSessionId: 'session-card-a',
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(bridgeMocks.openCard).toHaveBeenCalledTimes(1);
  });

  it('unlistens its card-scoped notification listener exactly once during normal cleanup', async () => {
    const registrations = installDeferredListeners();
    const unlistenNotification = vi.fn();
    const view = render(<CodexChatView card={makeCard()} />);

    await act(async () => {
      registrations.notification.resolve(unlistenNotification);
      await Promise.resolve();
    });

    expect(unlistenNotification).not.toHaveBeenCalled();

    view.unmount();
    expect(unlistenNotification).toHaveBeenCalledTimes(1);
  });

  it('immediately unlistens when notification registration resolves after cleanup', async () => {
    const registrations = installDeferredListeners();
    const unlistenNotification = vi.fn();
    const view = render(<CodexChatView card={makeCard()} />);

    await waitFor(() => {
      expect(bridgeMocks.onNotification).toHaveBeenCalledTimes(1);
    });
    view.unmount();

    await act(async () => {
      registrations.notification.resolve(unlistenNotification);
      await Promise.resolve();
    });

    expect(unlistenNotification).toHaveBeenCalledTimes(1);
  });

  it('handles listener registration rejection without an unhandled promise', async () => {
    bridgeMocks.onNotification.mockRejectedValue(new Error('notification listen failed'));

    render(<CodexChatView card={makeCard()} />);

    await waitFor(() => expect(loggerMocks.warn).toHaveBeenCalledTimes(1));
    expect(loggerMocks.warn.mock.calls.map(([message]) => message)).toEqual(
      ['[CodexChatView] failed to listen for notification'],
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
    expect(within(view.container).queryByText('hidden delta', { selector: 'pre' }))
      .not.toBeInTheDocument();

    act(() => {
      emitNotification({
        cardId: 'card-a',
        method: 'item/completed',
        params: {
          item: { id: 'hidden-item', type: 'agentMessage', text: 'hidden complete' },
        },
        raw: null,
      });
      useCodexRequestStore.getState().ingestRequest(
        {
          requestId: 'approval-hidden',
          cardId: 'card-a',
          method: 'item/commandExecution/requestApproval',
          params: { command: 'echo hidden approval', cwd: '/repo/card-a' },
          raw: null,
        },
        'card-a',
      );
    });

    expect(within(view.container).queryByText('hidden complete', { selector: 'pre' }))
      .not.toBeInTheDocument();
    expect(within(view.container).getByText('echo hidden approval')).toBeInTheDocument();
    expect(storeMocks.updateCardReplyPreview).toHaveBeenCalledWith('card-a', 'hidden complete');

    act(() => {
      useCodexRequestStore.getState().recordDisconnected('hidden app-server disconnected');
    });
    expect(within(view.container).getByText('hidden app-server disconnected')).toBeInTheDocument();

    view.rerender(<CodexChatView card={makeCard()} active />);
    expect(await within(view.container).findByText('hidden complete', { selector: 'pre' }))
      .toBeInTheDocument();
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

    view.rerender(
      <>
        <section data-testid="card-a-view">
          <CodexChatView card={makeCard('card-a')} active />
        </section>
        <section data-testid="card-b-view">
          <CodexChatView card={makeCard('card-b')} active />
        </section>
      </>,
    );
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

    view.rerender(<CodexChatView card={makeCard()} active />);
    const streamedBody = await waitFor(() => {
      const body = view.container.querySelector('pre');
      expect(body).not.toBeNull();
      return body;
    });
    expect(streamedBody).not.toBeNull();
    expect(streamedBody?.textContent).toBe(expected);
  });

  it('mounts at most 160 history rows while keeping older pages reachable', async () => {
    bridgeMocks.openCard.mockResolvedValue({
      cardId: 'card-a',
      threadId: 'thread-card-a',
      sessionId: 'session-card-a',
      threadPath: null,
      status: 'resumed',
      thread: {
        turns: [
          {
            items: Array.from({ length: 1_001 }, (_, index) => ({
              type: 'agentMessage',
              id: `item-${index}`,
              text: `reply-${index}`,
            })),
          },
        ],
      },
    });

    const view = render(<CodexChatView card={makeCard()} />);
    await waitForReady(view.container);

    expect(
      await within(view.container).findByText('reply-1000', {
        selector: 'pre',
      }),
    ).toBeInTheDocument();
    expect(within(view.container).queryByText('reply-0')).not.toBeInTheDocument();
    expect(view.container.querySelectorAll('pre')).toHaveLength(160);

    fireEvent.click(within(view.container).getByTestId('conversation-window-older'));

    expect(await within(view.container).findByText('reply-840', { selector: 'pre' })).toBeInTheDocument();
    expect(within(view.container).queryByText('reply-1000')).not.toBeInTheDocument();
    expect(within(view.container).getByTestId('conversation-window-newer')).toBeInTheDocument();
    expect(within(view.container).getByTestId('conversation-window-latest')).toBeInTheDocument();
  });

  it('keeps the existing response payload and clears the request notification after success', async () => {
    act(() => {
      useCodexRequestStore.getState().ingestRequest(
        {
          requestId: 'approval-response',
          cardId: 'card-a',
          method: 'item/commandExecution/requestApproval',
          params: { command: 'echo approved', cwd: '/repo/card-a' },
          raw: null,
        },
        'card-a',
      );
      useCodexRequestStore
        .getState()
        .attachNotification('approval-response', 'notification-response');
    });

    const view = render(<CodexChatView card={makeCard()} active={false} />);
    await waitForReady(view.container);

    fireEvent.click(
      screen.getByRole('button', {
        name: /^(允许|Accept)$/,
      }),
    );

    await waitFor(() => {
      expect(bridgeMocks.respondRequest).toHaveBeenCalledWith(
        'approval-response',
        { decision: 'accept' },
      );
      expect(useCodexRequestStore.getState().requests).toEqual([]);
    });
    expect(storeMocks.removeNotification).toHaveBeenCalledWith('notification-response');
  });
});
