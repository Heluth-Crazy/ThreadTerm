export type TerminalStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'completed'
  | 'failed';

export interface CardMeta {
  id: string;
  status: TerminalStatus;
  lastReplyPreview: string;
  hiddenLineCount: number;
  recentOutputBytes: number;
}

export interface NotificationEntry {
  id: string;
  cardId: string;
  kind: string;
  message: string;
  createdAt: number;
}

export type ClientMessage =
  | { kind: 'subscribe'; card_ids?: string[] }
  | { kind: 'input'; card_id: string; data: string }
  | { kind: 'resize'; card_id: string; cols: number; rows: number }
  | {
      kind: 'spawn';
      terminal_type: string;
      project_path: string;
      command?: string;
    }
  | { kind: 'close'; card_id: string }
  | { kind: 'pin'; card_id: string; pinned: boolean }
  | { kind: 'set_intent'; card_id: string; intent: string | null }
  | { kind: 'mark_read'; card_id: string }
  | { kind: 'ping' };

export type ServerMessage =
  | { kind: 'snapshot'; cards: CardMeta[]; notifications: NotificationEntry[] }
  | { kind: 'card_added' | 'card_updated' | 'card_removed'; card: CardMeta }
  | {
      kind: 'preview';
      card_id: string;
      last_reply_preview: string;
      hidden_line_count: number;
    }
  | { kind: 'state'; card_id: string; status: TerminalStatus }
  | {
      kind: 'attention';
      card_id: string;
      attention_kind: 'waiting' | 'failed' | string;
      message: string;
    }
  | { kind: 'exit'; card_id: string; code: number | null }
  | { kind: 'notification'; entry: NotificationEntry }
  | { kind: 'pong'; t: number }
  | { kind: 'error'; code: string; message: string };
