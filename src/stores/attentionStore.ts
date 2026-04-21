import { create } from 'zustand';
import type { AttentionReason, PendingPermissionRequest } from './sessionStatusStore';

export type AttentionItemStatus = 'active' | 'resolved' | 'dismissed';
export type AttentionItemKind = 'approval' | 'error' | 'aborted' | 'waiting';
export type AttentionRiskLevel = 'low' | 'medium' | 'high';
export type ApprovalRequestStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface AttentionItem {
  id: string;
  sessionId: string;
  kind: AttentionItemKind;
  status: AttentionItemStatus;
  reason: AttentionReason;
  title: string;
  message?: string;
  riskLevel: AttentionRiskLevel;
  createdAt: number;
  updatedAt: number;
  requestId?: string;
}

export interface ApprovalRequest extends PendingPermissionRequest {
  id: string;
  riskLevel: AttentionRiskLevel;
  status: ApprovalRequestStatus;
  createdAt: number;
  updatedAt: number;
}

interface AttentionState {
  attentionItems: Record<string, AttentionItem>;
  approvalRequests: Record<string, ApprovalRequest>;
  upsertAttentionItem: (item: Omit<AttentionItem, 'createdAt' | 'updatedAt' | 'status'> & Partial<Pick<AttentionItem, 'createdAt' | 'updatedAt' | 'status'>>) => void;
  resolveAttentionItem: (id: string) => void;
  dismissAttentionItem: (id: string) => void;
  resolveAttentionItemsForSession: (sessionId: string) => void;
  upsertApprovalRequest: (request: PendingPermissionRequest) => void;
  approveRequestOptimistic: (sessionId: string) => void;
  denyRequestOptimistic: (sessionId: string) => void;
  expireRequest: (sessionId: string) => void;
  clearApprovalRequest: (sessionId: string) => void;
  getActiveAttentionItems: () => AttentionItem[];
  getPendingApprovals: () => ApprovalRequest[];
}

const now = () => Date.now();
const APPROVAL_RISK_PRIORITY: Record<AttentionRiskLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function buildAttentionItemId(sessionId: string, reason: AttentionReason, requestId?: string): string {
  return requestId ? `${sessionId}:${reason}:${requestId}` : `${sessionId}:${reason}`;
}

export function getAttentionKind(reason: AttentionReason): AttentionItemKind {
  switch (reason) {
    case 'permission':
      return 'approval';
    case 'aborted':
      return 'aborted';
    default:
      return 'error';
  }
}

export function getAttentionRiskLevel(reason: AttentionReason, toolName?: string): AttentionRiskLevel {
  if (reason === 'aborted') return 'medium';
  if (reason === 'permission') {
    return toolName && /bash|edit|write|delete|exec|terminal/i.test(toolName) ? 'high' : 'medium';
  }
  return 'high';
}

export const useAttentionStore = create<AttentionState>()((set, get) => ({
  attentionItems: {},
  approvalRequests: {},

  upsertAttentionItem: (item) =>
    set((state) => {
      const existing = state.attentionItems[item.id];
      const createdAt = item.createdAt ?? existing?.createdAt ?? now();
      return {
        attentionItems: {
          ...state.attentionItems,
          [item.id]: {
            ...existing,
            ...item,
            status: item.status ?? existing?.status ?? 'active',
            createdAt,
            updatedAt: item.updatedAt ?? now(),
          },
        },
      };
    }),

  resolveAttentionItem: (id) =>
    set((state) => {
      const existing = state.attentionItems[id];
      if (!existing) return state;
      return {
        attentionItems: {
          ...state.attentionItems,
          [id]: { ...existing, status: 'resolved', updatedAt: now() },
        },
      };
    }),

  dismissAttentionItem: (id) =>
    set((state) => {
      const existing = state.attentionItems[id];
      if (!existing) return state;
      return {
        attentionItems: {
          ...state.attentionItems,
          [id]: { ...existing, status: 'dismissed', updatedAt: now() },
        },
      };
    }),

  resolveAttentionItemsForSession: (sessionId) =>
    set((state) => {
      const attentionItems = { ...state.attentionItems };
      let changed = false;
      for (const [id, item] of Object.entries(attentionItems)) {
        if (item.sessionId === sessionId && item.status === 'active') {
          attentionItems[id] = { ...item, status: 'resolved', updatedAt: now() };
          changed = true;
        }
      }
      return changed ? { attentionItems } : state;
    }),

  upsertApprovalRequest: (request) =>
    set((state) => {
      const createdAt = state.approvalRequests[request.sessionId]?.createdAt ?? now();
      return {
        approvalRequests: {
          ...state.approvalRequests,
          [request.sessionId]: {
            ...request,
            id: buildAttentionItemId(request.sessionId, 'permission', request.requestId),
            riskLevel: getAttentionRiskLevel('permission', request.toolName),
            status: 'pending',
            createdAt,
            updatedAt: now(),
          },
        },
      };
    }),

  approveRequestOptimistic: (sessionId) =>
    set((state) => {
      const request = state.approvalRequests[sessionId];
      if (!request) return state;
      return {
        approvalRequests: {
          ...state.approvalRequests,
          [sessionId]: { ...request, status: 'approved', updatedAt: now() },
        },
      };
    }),

  denyRequestOptimistic: (sessionId) =>
    set((state) => {
      const request = state.approvalRequests[sessionId];
      if (!request) return state;
      return {
        approvalRequests: {
          ...state.approvalRequests,
          [sessionId]: { ...request, status: 'denied', updatedAt: now() },
        },
      };
    }),

  expireRequest: (sessionId) =>
    set((state) => {
      const request = state.approvalRequests[sessionId];
      if (!request) return state;
      return {
        approvalRequests: {
          ...state.approvalRequests,
          [sessionId]: { ...request, status: 'expired', updatedAt: now() },
        },
      };
    }),

  clearApprovalRequest: (sessionId) =>
    set((state) => {
      if (!state.approvalRequests[sessionId]) return state;
      const { [sessionId]: _, ...rest } = state.approvalRequests;
      return { approvalRequests: rest };
    }),

  getActiveAttentionItems: () =>
    Object.values(get().attentionItems)
      .filter((item) => item.status === 'active')
      .sort((a, b) => b.updatedAt - a.updatedAt),

  getPendingApprovals: () =>
    Object.values(get().approvalRequests)
      .filter((request) => request.status === 'pending')
      .sort((a, b) => {
        const riskDelta = (APPROVAL_RISK_PRIORITY[a.riskLevel] ?? 99) - (APPROVAL_RISK_PRIORITY[b.riskLevel] ?? 99);
        if (riskDelta !== 0) return riskDelta;
        return b.updatedAt - a.updatedAt;
      }),
}));
