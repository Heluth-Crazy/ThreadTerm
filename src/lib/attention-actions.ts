import { useAttentionStore, type ApprovalRequest, type AttentionItem } from '../stores/attentionStore';
import { useSessionStatusStore } from '../stores/sessionStatusStore';
import type { AttentionReason } from '../stores/sessionStatusStore';

export function getStandaloneAttentionItems(
  items: AttentionItem[],
  pendingApprovals: ApprovalRequest[],
): AttentionItem[] {
  const pendingApprovalSessionIds = new Set(pendingApprovals.map((request) => request.sessionId));
  return items.filter((item) => !(item.reason === 'permission' && pendingApprovalSessionIds.has(item.sessionId)));
}

function getDerivedAttentionReason(sessionId: string): AttentionReason | undefined {
  const attentionStore = useAttentionStore.getState();

  if (attentionStore.approvalRequests[sessionId]?.status === 'pending') {
    return 'permission';
  }

  return attentionStore
    .getActiveAttentionItems()
    .find((item) => item.sessionId === sessionId)?.reason;
}

export function acknowledgeAttentionItem(attentionItemId: string): void {
  const attentionStore = useAttentionStore.getState();
  const sessionStore = useSessionStatusStore.getState();
  const attentionItem = attentionStore.attentionItems[attentionItemId];

  if (!attentionItem) {
    return;
  }

  const sessionId = attentionItem.sessionId;
  const pendingApproval = attentionStore.approvalRequests[sessionId];
  const clearsPendingApproval =
    attentionItem.reason === 'permission'
    && pendingApproval?.status === 'pending'
    && pendingApproval.requestId === attentionItem.requestId;

  attentionStore.resolveAttentionItem(attentionItemId);

  if (clearsPendingApproval) {
    attentionStore.clearApprovalRequest(sessionId);
  }

  const derivedReason = getDerivedAttentionReason(sessionId);
  if (derivedReason) {
    sessionStore.setNeedsAttention(sessionId, derivedReason);
    return;
  }

  sessionStore.setIdle(sessionId);
}
