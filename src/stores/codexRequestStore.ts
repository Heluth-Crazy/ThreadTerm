import { create } from 'zustand';
import type { CodexAppRequestPayload } from '../lib/tauri-bridge';
import {
  codexRequestKey,
  codexRequestThreadId,
  type PendingCodexRequest,
} from '../lib/codexApp/pendingRequest';

const MAX_PENDING_CODEX_REQUESTS = 100;

interface CodexRequestStore {
  requests: PendingCodexRequest[];
  disconnectedMessage: string | null;
  disconnectRevision: number;
  ingestRequest: (
    payload: CodexAppRequestPayload,
    cardId: string,
    createdAt?: number,
  ) => PendingCodexRequest | null;
  attachNotification: (key: string, notificationId: string) => void;
  removeRequest: (key: string) => PendingCodexRequest | null;
  clearRequests: () => PendingCodexRequest[];
  recordDisconnected: (message: string) => void;
  reset: () => void;
}

export const useCodexRequestStore = create<CodexRequestStore>((set, get) => ({
  requests: [],
  disconnectedMessage: null,
  disconnectRevision: 0,

  ingestRequest: (payload, cardId, createdAt = Date.now()) => {
    const key = codexRequestKey(payload.requestId);
    if (get().requests.some((request) => request.key === key)) return null;

    const request: PendingCodexRequest = {
      key,
      requestId: payload.requestId,
      cardId,
      threadId: codexRequestThreadId(payload.params),
      method: payload.method,
      params: payload.params,
      // The full app-server envelope duplicates params and can contain large
      // tool payloads. requestId/method/params are the authoritative live data.
      raw: null,
      createdAt,
      notificationId: null,
    };

    set((state) => ({
      requests: [...state.requests, request].slice(-MAX_PENDING_CODEX_REQUESTS),
      disconnectedMessage: null,
    }));
    return request;
  },

  attachNotification: (key, notificationId) =>
    set((state) => {
      const index = state.requests.findIndex((request) => request.key === key);
      if (index === -1 || state.requests[index].notificationId === notificationId) return state;
      const requests = [...state.requests];
      requests[index] = { ...requests[index], notificationId };
      return { requests };
    }),

  removeRequest: (key) => {
    const request = get().requests.find((candidate) => candidate.key === key) ?? null;
    if (!request) return null;
    set((state) => ({
      requests: state.requests.filter((candidate) => candidate.key !== key),
    }));
    return request;
  },

  clearRequests: () => {
    const requests = get().requests;
    if (requests.length > 0) set({ requests: [] });
    return requests;
  },

  recordDisconnected: (message) =>
    set((state) => ({
      requests: [],
      disconnectedMessage: message,
      disconnectRevision: state.disconnectRevision + 1,
    })),

  reset: () =>
    set({
      requests: [],
      disconnectedMessage: null,
      disconnectRevision: 0,
    }),
}));

export { MAX_PENDING_CODEX_REQUESTS };
