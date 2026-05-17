import type { ServerMessage, CardMeta, NotificationEntry } from '@shared/mobile/bridge/protocol';
import type { MobileThemeMessage } from '../theme';

export interface MobileBridgeState {
  cards: CardMeta[];
  notifications: NotificationEntry[];
  activeCardId: string | null;
  wsStatus: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
  lastError: string | null;
  warmingUp: boolean;
  ptyStatusByCardId: Record<string, CardMeta['status']>;
  recentOutputBytesByCardId: Record<string, number>;
  theme: MobileThemeMessage | null;
}

export const initialBridgeState: MobileBridgeState = {
  cards: [],
  notifications: [],
  activeCardId: null,
  wsStatus: 'idle',
  lastError: null,
  warmingUp: false,
  ptyStatusByCardId: {},
  recentOutputBytesByCardId: {},
  theme: null,
};

export type MobileBridgeAction =
  | { type: 'ws-status'; status: MobileBridgeState['wsStatus'] }
  | { type: 'ws-error'; message: string }
  | { type: 'select-card'; cardId: string }
  | { type: 'server-message'; message: ServerMessage };

export function reduceBridgeState(
  state: MobileBridgeState,
  action: MobileBridgeAction,
): MobileBridgeState {
  switch (action.type) {
    case 'ws-status':
      return { ...state, wsStatus: action.status };
    case 'ws-error':
      return { ...state, wsStatus: 'error', lastError: action.message };
    case 'select-card':
      return { ...state, activeCardId: action.cardId };
    case 'server-message':
      return applyServerMessage(state, action.message);
    default:
      return state;
  }
}

export function applyServerMessage(
  state: MobileBridgeState,
  message: ServerMessage,
): MobileBridgeState {
  switch (message.kind) {
    case 'snapshot':
      return {
        ...state,
        cards: message.cards,
        notifications: message.notifications,
        warmingUp: Boolean(message.warmingUp),
        activeCardId:
          state.activeCardId && message.cards.some((card) => card.id === state.activeCardId)
            ? state.activeCardId
            : message.cards[0]?.id ?? null,
        ptyStatusByCardId: Object.fromEntries(message.cards.map((card) => [card.id, card.status])),
        recentOutputBytesByCardId: Object.fromEntries(
          message.cards.map((card) => [card.id, card.recentOutputBytes]),
        ),
      };
    case 'card_added':
      return {
        ...state,
        cards: upsertCard(state.cards, message.card),
        activeCardId: state.activeCardId ?? message.card.id,
      };
    case 'card_updated':
      return {
        ...state,
        cards: upsertCard(state.cards, message.card),
        ptyStatusByCardId: {
          ...state.ptyStatusByCardId,
          [message.card.id]: message.card.status,
        },
        recentOutputBytesByCardId: {
          ...state.recentOutputBytesByCardId,
          [message.card.id]: message.card.recentOutputBytes,
        },
      };
    case 'card_removed': {
      const cards = state.cards.filter((card) => card.id !== message.card.id);
      return {
        ...state,
        cards,
        activeCardId: state.activeCardId === message.card.id ? cards[0]?.id ?? null : state.activeCardId,
      };
    }
    case 'spawn_result':
    case 'activate_result':
      return {
        ...state,
        activeCardId: message.ok && message.card_id ? message.card_id : state.activeCardId,
        lastError: message.ok ? state.lastError : message.message ?? message.error_code ?? state.lastError,
      };
    case 'close_result': {
      if (!message.ok || !message.card_id) {
        return {
          ...state,
          lastError: message.message ?? message.error_code ?? state.lastError,
        };
      }
      const cards = state.cards.filter((card) => card.id !== message.card_id);
      return {
        ...state,
        cards,
        activeCardId: state.activeCardId === message.card_id ? cards[0]?.id ?? null : state.activeCardId,
      };
    }
    case 'preview':
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === message.card_id
            ? {
                ...card,
                lastReplyPreview: message.last_reply_preview,
                summaryLine: message.summary_line,
                hiddenLineCount: message.hidden_line_count,
              }
            : card,
        ),
      };
    case 'state':
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === message.card_id ? { ...card, status: message.status } : card,
        ),
        ptyStatusByCardId: {
          ...state.ptyStatusByCardId,
          [message.card_id]: message.status,
        },
      };
    case 'exit': {
      const status = message.code === 0 || message.code === null ? 'completed' : 'failed';
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === message.card_id ? { ...card, status } : card,
        ),
        ptyStatusByCardId: {
          ...state.ptyStatusByCardId,
          [message.card_id]: status,
        },
      };
    }
    case 'attention':
      return {
        ...state,
        notifications: [
          {
            id: `${message.card_id}:${Date.now()}`,
            cardId: message.card_id,
            kind: message.attention_kind,
            message: message.message,
            createdAt: Date.now(),
          },
          ...state.notifications,
        ].slice(0, 12),
      };
    case 'notification':
      return {
        ...state,
        notifications: [
          message.entry,
          ...state.notifications.filter((entry) => entry.id !== message.entry.id),
        ].slice(0, 12),
      };
    case 'theme':
      return {
        ...state,
        theme: {
          app: message.app,
          terminal: message.terminal,
          mode: message.mode,
        },
      };
    case 'error':
      return {
        ...state,
        lastError: message.message,
      };
    default:
      return state;
  }
}

function upsertCard(cards: CardMeta[], next: CardMeta): CardMeta[] {
  const index = cards.findIndex((card) => card.id === next.id);
  if (index === -1) return [next, ...cards];
  return cards.map((card) => (card.id === next.id ? next : card));
}
