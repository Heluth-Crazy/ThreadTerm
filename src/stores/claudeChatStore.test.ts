import { beforeEach, describe, expect, it } from 'vitest';
import { useClaudeChatStore } from './claudeChatStore';

describe('claudeChatStore', () => {
  beforeEach(() => {
    useClaudeChatStore.setState({ sessions: {} });
  });

  it('keeps status and normalized messages isolated per card', () => {
    const store = useClaudeChatStore.getState();
    store.prepareCard('card-a');
    store.markStarted('card-a');
    store.applyStatus({
      ev: 'session.status',
      cardId: 'card-a',
      phase: 'running',
      sessionId: 'session-a',
    });
    store.applyMessage('card-a', {
      type: 'assistant',
      message: {
        id: 'msg-a',
        content: [{ type: 'text', text: 'hello' }],
      },
    });
    store.prepareCard('card-b');

    const state = useClaudeChatStore.getState();
    expect(state.sessions['card-a']).toMatchObject({
      started: true,
      phase: 'running',
      sessionId: 'session-a',
    });
    expect(state.sessions['card-a'].items[0]).toMatchObject({
      kind: 'assistant',
      body: 'hello',
    });
    expect(state.sessions['card-b'].items).toEqual([]);
  });

  it('queues multiple approvals and resolves only the targeted request', () => {
    const store = useClaudeChatStore.getState();
    store.upsertRequest({
      ev: 'session.request',
      cardId: 'card-a',
      requestId: 'request-1',
      kind: 'can_use_tool',
      toolName: 'Read',
      input: { path: 'a' },
    });
    store.upsertRequest({
      ev: 'session.request',
      cardId: 'card-a',
      requestId: 'request-2',
      kind: 'can_use_tool',
      toolName: 'Bash',
      input: { command: 'npm test' },
    });
    store.removeRequest('card-a', 'request-1');

    expect(
      useClaudeChatStore
        .getState()
        .sessions['card-a'].pendingRequests.map(
          (request) => request.requestId,
        ),
    ).toEqual(['request-2']);
  });

  it('moves every live card to a disconnected terminal state', () => {
    const store = useClaudeChatStore.getState();
    store.prepareCard('card-a');
    store.markStarted('card-a');
    store.prepareCard('card-b');
    store.markStarted('card-b');
    store.markDisconnected('sidecar stopped');

    const sessions = useClaudeChatStore.getState().sessions;
    expect(sessions['card-a']).toMatchObject({
      started: false,
      phase: 'disconnected',
      lastError: 'sidecar stopped',
    });
    expect(sessions['card-b']).toMatchObject({
      started: false,
      phase: 'disconnected',
      lastError: 'sidecar stopped',
    });
  });
});
