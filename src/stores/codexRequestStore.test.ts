import { beforeEach, describe, expect, it } from 'vitest';
import type { CodexAppRequestPayload } from '../lib/tauri-bridge';
import { MAX_PENDING_CODEX_REQUESTS, useCodexRequestStore } from './codexRequestStore';

function payload(requestId: unknown): CodexAppRequestPayload {
  return {
    requestId,
    cardId: 'card-a',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-a', command: 'npm test' },
    raw: null,
  };
}

beforeEach(() => {
  useCodexRequestStore.getState().reset();
});
describe('codexRequestStore', () => {
  it('deduplicates request ids and attaches notification metadata', () => {
    const first = useCodexRequestStore.getState().ingestRequest(payload('request-a'), 'card-a', 42);
    const duplicate = useCodexRequestStore
      .getState()
      .ingestRequest(payload('request-a'), 'card-a', 43);

    expect(first).toMatchObject({
      key: 'request-a',
      cardId: 'card-a',
      threadId: 'thread-a',
      createdAt: 42,
      notificationId: null,
    });
    expect(duplicate).toBeNull();

    useCodexRequestStore.getState().attachNotification('request-a', 'notification-a');
    expect(useCodexRequestStore.getState().requests[0].notificationId).toBe('notification-a');
  });

  it('returns removed requests so notification cleanup can stay in one response funnel', () => {
    useCodexRequestStore.getState().ingestRequest(payload('request-a'), 'card-a');
    useCodexRequestStore.getState().attachNotification('request-a', 'notification-a');

    expect(useCodexRequestStore.getState().removeRequest('request-a')).toMatchObject({
      notificationId: 'notification-a',
    });
    expect(useCodexRequestStore.getState().removeRequest('request-a')).toBeNull();
    expect(useCodexRequestStore.getState().requests).toEqual([]);
  });

  it('clears executable requests and records a disconnect generation', () => {
    useCodexRequestStore.getState().ingestRequest(payload('request-a'), 'card-a');
    useCodexRequestStore.getState().recordDisconnected('server stopped');

    expect(useCodexRequestStore.getState()).toMatchObject({
      requests: [],
      disconnectedMessage: 'server stopped',
      disconnectRevision: 1,
    });
  });

  it('caps the in-memory queue', () => {
    for (let index = 0; index < MAX_PENDING_CODEX_REQUESTS + 4; index += 1) {
      useCodexRequestStore
        .getState()
        .ingestRequest(payload(`request-${index}`), 'card-a', index);
    }

    const requests = useCodexRequestStore.getState().requests;
    expect(requests).toHaveLength(MAX_PENDING_CODEX_REQUESTS);
    expect(requests[0].key).toBe('request-4');
  });
});
