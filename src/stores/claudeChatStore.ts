import { create } from 'zustand';
import type {
  ClaudeChatPhase,
  ClaudeChatRequestEvent,
  ClaudeChatStatusEvent,
} from '../lib/claudeChat/api';
import {
  applyClaudeSdkMessage,
  createClaudeUserItem,
  type ClaudeDisplayItem,
} from '../lib/claudeChat/normalize';

export interface PendingClaudeRequest extends ClaudeChatRequestEvent {
  receivedAt: number;
}

export interface ClaudeCardChatState {
  started: boolean;
  phase: ClaudeChatPhase;
  sessionId: string | null;
  items: ClaudeDisplayItem[];
  pendingRequests: PendingClaudeRequest[];
  lastError: string | null;
}

interface ClaudeChatStore {
  sessions: Record<string, ClaudeCardChatState>;
  prepareCard: (cardId: string, sessionId?: string | null) => void;
  markStarted: (cardId: string, sessionId?: string | null) => void;
  applyStatus: (payload: ClaudeChatStatusEvent) => void;
  applyMessage: (cardId: string, message: unknown) => void;
  appendUserMessage: (cardId: string, text: string) => void;
  upsertRequest: (payload: ClaudeChatRequestEvent) => void;
  removeRequest: (cardId: string, requestId: string) => void;
  reportError: (cardId: string, message: string) => void;
  setError: (cardId: string, message: string) => void;
  markDisconnected: (message: string) => void;
  resetCard: (cardId: string) => void;
}

export const EMPTY_CLAUDE_CHAT_STATE: ClaudeCardChatState = Object.freeze({
  started: false,
  phase: 'checking',
  sessionId: null,
  items: Object.freeze([]) as unknown as ClaudeDisplayItem[],
  pendingRequests: Object.freeze([]) as unknown as PendingClaudeRequest[],
  lastError: null,
});

let localMessageSequence = 0;

export const useClaudeChatStore = create<ClaudeChatStore>((set) => ({
  sessions: {},

  prepareCard: (cardId, sessionId = null) =>
    set((state) => {
      const existing = state.sessions[cardId];
      if (existing) {
        if (!sessionId || existing.sessionId === sessionId) return state;
        return {
          sessions: {
            ...state.sessions,
            [cardId]: { ...existing, sessionId },
          },
        };
      }
      return {
        sessions: {
          ...state.sessions,
          [cardId]: createCardState(sessionId),
        },
      };
    }),

  markStarted: (cardId, sessionId = null) =>
    set((state) =>
      updateCard(state, cardId, (existing) => ({
        ...existing,
        started: true,
        phase:
          existing.phase === 'checking' || existing.phase === 'starting'
            ? 'ready'
            : existing.phase,
        sessionId: sessionId ?? existing.sessionId,
        lastError: null,
      })),
    ),

  applyStatus: (payload) =>
    set((state) =>
      updateCard(state, payload.cardId, (existing) => ({
        ...existing,
        started:
          payload.phase === 'closed' ||
          payload.phase === 'error' ||
          payload.phase === 'disconnected'
            ? false
            : existing.started || payload.phase !== 'checking',
        phase: payload.phase,
        sessionId: payload.sessionId ?? existing.sessionId,
        lastError:
          payload.phase === 'error'
            ? payload.detail ?? 'Claude Chat failed.'
            : null,
        pendingRequests:
          payload.phase === 'closed' || payload.phase === 'error'
            ? []
            : existing.pendingRequests,
      })),
    ),

  applyMessage: (cardId, message) =>
    set((state) =>
      updateCard(state, cardId, (existing) => {
        const items = applyClaudeSdkMessage(existing.items, message);
        if (items === existing.items) return existing;
        return { ...existing, items };
      }),
    ),

  appendUserMessage: (cardId, text) =>
    set((state) =>
      updateCard(state, cardId, (existing) => ({
        ...existing,
        items: [
          ...existing.items,
          createClaudeUserItem(
            text,
            `local-user:${Date.now()}:${localMessageSequence++}`,
          ),
        ],
      })),
    ),

  upsertRequest: (payload) =>
    set((state) =>
      updateCard(state, payload.cardId, (existing) => {
        const pending = existing.pendingRequests.filter(
          (request) => request.requestId !== payload.requestId,
        );
        return {
          ...existing,
          pendingRequests: [
            ...pending,
            { ...payload, receivedAt: Date.now() },
          ],
        };
      }),
    ),

  removeRequest: (cardId, requestId) =>
    set((state) =>
      updateCard(state, cardId, (existing) => {
        const pendingRequests = existing.pendingRequests.filter(
          (request) => request.requestId !== requestId,
        );
        if (pendingRequests.length === existing.pendingRequests.length) {
          return existing;
        }
        return { ...existing, pendingRequests };
      }),
    ),

  reportError: (cardId, message) =>
    set((state) =>
      updateCard(state, cardId, (existing) => ({
        ...existing,
        lastError: message,
      })),
    ),

  setError: (cardId, message) =>
    set((state) =>
      updateCard(state, cardId, (existing) => ({
        ...existing,
        started: false,
        phase: 'error',
        lastError: message,
      })),
    ),

  markDisconnected: (message) =>
    set((state) => ({
      sessions: Object.fromEntries(
        Object.entries(state.sessions).map(([cardId, session]) => [
          cardId,
          {
            ...session,
            started: false,
            phase: 'disconnected' as const,
            pendingRequests: [],
            lastError: message,
          },
        ]),
      ),
    })),

  resetCard: (cardId) =>
    set((state) => {
      if (!state.sessions[cardId]) return state;
      const sessions = { ...state.sessions };
      delete sessions[cardId];
      return { sessions };
    }),
}));

function createCardState(sessionId: string | null): ClaudeCardChatState {
  return {
    started: false,
    phase: 'checking',
    sessionId,
    items: [],
    pendingRequests: [],
    lastError: null,
  };
}

function updateCard(
  state: Pick<ClaudeChatStore, 'sessions'>,
  cardId: string,
  update: (existing: ClaudeCardChatState) => ClaudeCardChatState,
): Pick<ClaudeChatStore, 'sessions'> {
  const existing = state.sessions[cardId] ?? createCardState(null);
  const next = update(existing);
  if (next === existing) return state;
  return {
    sessions: {
      ...state.sessions,
      [cardId]: next,
    },
  };
}
