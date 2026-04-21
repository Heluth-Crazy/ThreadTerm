import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildAttentionItemId,
  useAttentionStore,
} from './attentionStore';

beforeEach(() => {
  useAttentionStore.setState({
    attentionItems: {},
    approvalRequests: {},
  });
});

describe('attentionStore', () => {
  it('creates pending approval requests with derived risk and sorts high-risk items first', () => {
    const store = useAttentionStore.getState();
    store.upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Read',
      input: { path: 'README.md' },
      sessionId: 's1',
    });
    store.upsertApprovalRequest({
      requestId: 'req-2',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      sessionId: 's2',
    });

    const requests = useAttentionStore.getState().getPendingApprovals();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      sessionId: 's2',
      requestId: 'req-2',
      riskLevel: 'high',
      status: 'pending',
    });
    expect(requests[1]).toMatchObject({
      sessionId: 's1',
      requestId: 'req-1',
      riskLevel: 'medium',
      status: 'pending',
    });
  });

  it('resolves all active attention items for a session', () => {
    const store = useAttentionStore.getState();
    store.upsertAttentionItem({
      id: buildAttentionItemId('s1', 'error'),
      sessionId: 's1',
      kind: 'error',
      reason: 'error',
      title: 'Session requires attention',
      riskLevel: 'high',
    });

    store.resolveAttentionItemsForSession('s1');

    expect(useAttentionStore.getState().attentionItems[buildAttentionItemId('s1', 'error')]?.status).toBe('resolved');
  });

  it('tracks optimistic approval transitions', () => {
    const store = useAttentionStore.getState();
    store.upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Write',
      input: { path: 'README.md' },
      sessionId: 's1',
    });

    store.approveRequestOptimistic('s1');
    expect(useAttentionStore.getState().approvalRequests.s1?.status).toBe('approved');

    store.upsertApprovalRequest({
      requestId: 'req-2',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      sessionId: 's2',
    });
    store.denyRequestOptimistic('s2');
    expect(useAttentionStore.getState().approvalRequests.s2?.status).toBe('denied');
  });
});
