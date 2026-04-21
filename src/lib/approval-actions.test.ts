import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, isTauriEnvMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  isTauriEnvMock: vi.fn(() => true),
}));

vi.mock('./tauri-bridge', () => ({
  invoke: invokeMock,
  isTauriEnv: isTauriEnvMock,
}));

import { respondToApprovalRequest } from './approval-actions';
import { useAttentionStore } from '../stores/attentionStore';
import { useBackgroundRunStore } from '../stores/backgroundRunStore';
import { useSessionStatusStore } from '../stores/sessionStatusStore';

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  isTauriEnvMock.mockReturnValue(true);
  useAttentionStore.setState({ attentionItems: {}, approvalRequests: {} });
  useBackgroundRunStore.setState({ runs: {} });
  useSessionStatusStore.setState({ statuses: {} });
});

describe('approval-actions', () => {
  it('optimistically updates approval state through the shared helper and invokes ai_approve_tool', async () => {
    useAttentionStore.getState().upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      sessionId: 's1',
    });
    useSessionStatusStore.getState().setNeedsAttention('s1', 'permission');
    useBackgroundRunStore.getState().createRun({
      id: 'run-1',
      sessionId: 's1',
      provider: 'claude',
      title: 'Run approval flow',
      source: 'agent',
      status: 'needs_attention',
      requiresApproval: true,
      attentionReason: 'approval',
    });

    await respondToApprovalRequest('s1', 'req-1', true);

    expect(invokeMock).toHaveBeenCalledWith('ai_approve_tool', {
      sessionId: 's1',
      permissionId: 'req-1',
      approved: true,
    });
    expect(useAttentionStore.getState().approvalRequests.s1).toBeUndefined();
    expect(useSessionStatusStore.getState().getStatus('s1').status).toBe('processing');
    expect(useBackgroundRunStore.getState().runs['run-1']).toMatchObject({
      status: 'running',
      requiresApproval: false,
      attentionReason: undefined,
    });
  });

  it('restores approval and attention state when ai_approve_tool fails', async () => {
    invokeMock.mockRejectedValueOnce(new Error('backend exploded'));
    const attentionItemId = 's1:permission:req-1';

    useAttentionStore.getState().upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      sessionId: 's1',
    });
    useAttentionStore.getState().upsertAttentionItem({
      id: attentionItemId,
      sessionId: 's1',
      kind: 'approval',
      reason: 'permission',
      title: 'Bash',
      message: 'Bash is waiting for approval.',
      riskLevel: 'high',
      requestId: 'req-1',
    });
    useSessionStatusStore.getState().setNeedsAttention('s1', 'permission');
    useBackgroundRunStore.getState().createRun({
      id: 'run-1',
      sessionId: 's1',
      provider: 'claude',
      title: 'Run approval flow',
      source: 'agent',
      status: 'needs_attention',
      requiresApproval: true,
      attentionReason: 'approval',
    });

    await expect(respondToApprovalRequest('s1', 'req-1', true)).rejects.toThrow('backend exploded');

    expect(useAttentionStore.getState().approvalRequests.s1).toMatchObject({
      requestId: 'req-1',
      status: 'pending',
      riskLevel: 'high',
    });
    expect(useAttentionStore.getState().attentionItems[attentionItemId]?.status).toBe('active');
    expect(useSessionStatusStore.getState().getStatus('s1')).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'permission',
    });
    expect(useBackgroundRunStore.getState().runs['run-1']).toMatchObject({
      status: 'needs_attention',
      requiresApproval: true,
      attentionReason: 'approval',
    });
  });

  it('rejects outside the Tauri runtime before invoking the backend', async () => {
    useAttentionStore.getState().upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      sessionId: 's1',
    });
    useSessionStatusStore.getState().setNeedsAttention('s1', 'permission');
    isTauriEnvMock.mockReturnValue(false);

    await expect(respondToApprovalRequest('s1', 'req-1', false)).rejects.toThrow(
      'Approval actions are only available in the Tauri desktop runtime right now.',
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useAttentionStore.getState().approvalRequests.s1?.status).toBe('pending');
    expect(useSessionStatusStore.getState().getStatus('s1')).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'permission',
    });
  });
});

