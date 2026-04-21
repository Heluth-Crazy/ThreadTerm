import { beforeEach, describe, expect, it } from 'vitest';
import { buildAttentionItemId, useAttentionStore } from '../stores/attentionStore';
import { useSessionStatusStore } from '../stores/sessionStatusStore';
import { acknowledgeAttentionItem, getStandaloneAttentionItems } from './attention-actions';

beforeEach(() => {
  useAttentionStore.setState({ attentionItems: {}, approvalRequests: {} });
  useSessionStatusStore.setState({ statuses: {} });
});

describe('attention-actions', () => {
  it('filters approval-backed permission items out of the standalone attention inbox', () => {
    useAttentionStore.getState().upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'npm test' },
      sessionId: 's1',
    });
    useAttentionStore.getState().upsertAttentionItem({
      id: buildAttentionItemId('s1', 'permission', 'req-1'),
      sessionId: 's1',
      kind: 'approval',
      reason: 'permission',
      title: 'Approval required',
      riskLevel: 'high',
      requestId: 'req-1',
    });
    useAttentionStore.getState().upsertAttentionItem({
      id: buildAttentionItemId('s2', 'error'),
      sessionId: 's2',
      kind: 'error',
      reason: 'error',
      title: 'Session requires attention',
      riskLevel: 'high',
    });

    const items = getStandaloneAttentionItems(
      useAttentionStore.getState().getActiveAttentionItems(),
      useAttentionStore.getState().getPendingApprovals(),
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.sessionId).toBe('s2');
  });

  it('acknowledging a non-permission item only resolves that item and preserves unrelated approval state', () => {
    const itemId = buildAttentionItemId('s1', 'error');

    useAttentionStore.getState().upsertAttentionItem({
      id: itemId,
      sessionId: 's1',
      kind: 'error',
      reason: 'error',
      title: 'Session requires attention',
      riskLevel: 'high',
    });
    useAttentionStore.getState().upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      sessionId: 's1',
    });
    useSessionStatusStore.getState().setNeedsAttention('s1', 'error');

    acknowledgeAttentionItem(itemId);

    expect(useAttentionStore.getState().attentionItems[itemId]?.status).toBe('resolved');
    expect(useAttentionStore.getState().approvalRequests.s1?.status).toBe('pending');
    expect(useSessionStatusStore.getState().getStatus('s1')).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'permission',
    });
  });

  it('derives permission attention from the attention store even when session pendingPermissions are absent', () => {
    const itemId = buildAttentionItemId('s1', 'error');

    useAttentionStore.getState().upsertAttentionItem({
      id: itemId,
      sessionId: 's1',
      kind: 'error',
      reason: 'error',
      title: 'Session requires attention',
      riskLevel: 'high',
    });
    useAttentionStore.getState().upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      sessionId: 's1',
    });
    useSessionStatusStore.getState().setNeedsAttention('s1', 'error');

    acknowledgeAttentionItem(itemId);

    expect(useAttentionStore.getState().approvalRequests.s1?.status).toBe('pending');
    expect(useSessionStatusStore.getState().getStatus('s1')).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'permission',
    });
  });

  it('acknowledging one item does not force idle while other active attention remains', () => {
    const errorItemId = buildAttentionItemId('s1', 'error');
    const abortedItemId = buildAttentionItemId('s1', 'aborted');

    useAttentionStore.getState().upsertAttentionItem({
      id: errorItemId,
      sessionId: 's1',
      kind: 'error',
      reason: 'error',
      title: 'Session requires attention',
      riskLevel: 'high',
    });
    useAttentionStore.getState().upsertAttentionItem({
      id: abortedItemId,
      sessionId: 's1',
      kind: 'aborted',
      reason: 'aborted',
      title: 'Session aborted',
      riskLevel: 'medium',
    });
    useSessionStatusStore.getState().setNeedsAttention('s1', 'error');

    acknowledgeAttentionItem(errorItemId);

    expect(useAttentionStore.getState().attentionItems[errorItemId]?.status).toBe('resolved');
    expect(useAttentionStore.getState().attentionItems[abortedItemId]?.status).toBe('active');
    expect(useSessionStatusStore.getState().getStatus('s1')).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'aborted',
    });
  });

  it('acknowledging the matching permission item clears the linked approval state and idles the session when nothing remains', () => {
    const permissionItemId = buildAttentionItemId('s1', 'permission', 'req-1');

    useAttentionStore.getState().upsertAttentionItem({
      id: permissionItemId,
      sessionId: 's1',
      kind: 'approval',
      reason: 'permission',
      requestId: 'req-1',
      title: 'Approval required',
      riskLevel: 'high',
    });
    useAttentionStore.getState().upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      sessionId: 's1',
    });
    useSessionStatusStore.getState().setNeedsAttention('s1', 'permission');

    acknowledgeAttentionItem(permissionItemId);

    expect(useAttentionStore.getState().attentionItems[permissionItemId]?.status).toBe('resolved');
    expect(useAttentionStore.getState().approvalRequests.s1).toBeUndefined();
    expect(useSessionStatusStore.getState().getStatus('s1')).toMatchObject({
      status: 'idle',
      attentionReason: undefined,
    });
  });

  it('acknowledging a permission item only recomputes state for the item session', () => {
    const permissionItemId = buildAttentionItemId('s1', 'permission', 'req-1');

    useAttentionStore.getState().upsertAttentionItem({
      id: permissionItemId,
      sessionId: 's1',
      kind: 'approval',
      reason: 'permission',
      requestId: 'req-1',
      title: 'Approval required',
      riskLevel: 'high',
    });
    useAttentionStore.getState().upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      sessionId: 's1',
    });
    useAttentionStore.getState().upsertAttentionItem({
      id: buildAttentionItemId('s2', 'error'),
      sessionId: 's2',
      kind: 'error',
      reason: 'error',
      title: 'Session requires attention',
      riskLevel: 'high',
    });
    useSessionStatusStore.getState().setNeedsAttention('s1', 'permission');
    useSessionStatusStore.getState().setNeedsAttention('s2', 'error');

    acknowledgeAttentionItem(permissionItemId);

    expect(useAttentionStore.getState().attentionItems[permissionItemId]?.status).toBe('resolved');
    expect(useAttentionStore.getState().approvalRequests.s1).toBeUndefined();
    expect(useSessionStatusStore.getState().getStatus('s1')).toMatchObject({
      status: 'idle',
      attentionReason: undefined,
    });
    expect(useSessionStatusStore.getState().getStatus('s2')).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'error',
    });
  });
});

