import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAttentionRouter } from './useAttentionRouter';
import { useAttentionStore, buildAttentionItemId } from '../stores/attentionStore';
import { useLiveGridStore } from '../stores/liveGridStore';
import { useToastStore } from '../stores/toastStore';

const WORKBENCH_STORAGE_KEY = 'openwork.workbench';

describe('useAttentionRouter', () => {
  beforeEach(() => {
    localStorage.clear();
    useAttentionStore.setState({ attentionItems: {}, approvalRequests: {} });
    useLiveGridStore.setState({
      layout: '2x2',
      cards: [],
      focusedCardId: null,
      messageSnapshots: {},
    });
    useToastStore.setState({ toasts: [] });
  });

  function addHighRiskApproval(sessionId: string) {
    useAttentionStore.getState().upsertAttentionItem({
      id: buildAttentionItemId(sessionId, 'permission', 'req-1'),
      sessionId,
      kind: 'approval',
      reason: 'permission',
      title: 'Approval required',
      riskLevel: 'high',
      requestId: 'req-1',
    });
  }

  it('does not hijack Live Grid focus when the user is outside Live Grid', () => {
    localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify({ activeNav: 'projects' }));
    useLiveGridStore.setState((state) => ({
      ...state,
      cards: [{ slotIndex: 0, sessionId: 'session-1', projectId: 'project-1', provider: 'claude', title: 'Agent A' }],
      focusedCardId: null,
    }));

    renderHook(() => useAttentionRouter());

    act(() => {
      addHighRiskApproval('session-1');
    });

    expect(useLiveGridStore.getState().focusedCardId).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('shows a lightweight warning toast in Live Grid instead of force-focusing a card', () => {
    localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify({ activeNav: 'livegrid' }));
    useLiveGridStore.setState((state) => ({
      ...state,
      cards: [{ slotIndex: 0, sessionId: 'session-1', projectId: 'project-1', provider: 'claude', title: 'Agent A' }],
      focusedCardId: null,
    }));

    renderHook(() => useAttentionRouter());

    act(() => {
      addHighRiskApproval('session-1');
    });

    expect(useLiveGridStore.getState().focusedCardId).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        type: 'warning',
        message: 'Session Agent A requires approval in Live Grid.',
      }),
    ]);
  });
});
