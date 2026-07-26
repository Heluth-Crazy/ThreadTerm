import type { AppThemeTokens, ResolvedThemeMode, TerminalThemeTokens } from '../../theme/themeTypes';

export type TerminalStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'completed'
  | 'failed';

export const BRIDGE_PROTOCOL_VERSION = 1;

export interface VersionedBridgeMessage {
  protocol_version: typeof BRIDGE_PROTOCOL_VERSION;
}

export interface CardMeta {
  id: string;
  ptyId?: string | null;
  status: TerminalStatus;
  projectPath: string;
  projectName: string;
  worktreePath?: string | null;
  branchLabel?: string | null;
  terminalType?: string | null;
  command?: string | null;
  createdAt?: number | null;
  lastActivity?: number | null;
  lastReplyPreview: string;
  summaryLine: string | null;
  hiddenLineCount: number;
  recentOutputBytes: number;
  messageCount?: number | null;
  unread?: boolean | null;
  providerSessionState?: string | null;
  ptyLive?: boolean;
  ptyState?: TerminalStatus | null;
  attachable?: boolean;
}

export interface NotificationEntry {
  id: string;
  cardId: string;
  kind: string;
  message: string;
  createdAt: number;
  title?: string;
  body?: string;
  read?: boolean;
  routing?: {
    origin: string;
    family: string;
    episodeKey?: string | null;
    fingerprint?: string | null;
  } | null;
}

export type MobileAttentionKind =
  | 'approval'
  | 'waiting_input'
  | 'failed'
  | 'review'
  | 'stalled';

export type MobileAttentionSeverity = 'info' | 'warning' | 'critical';

export type MobileExecutionContextStatus =
  | 'failed'
  | 'attention'
  | 'stalled'
  | 'running'
  | 'review'
  | 'idle';

export interface MobileAttentionItem {
  id: string;
  cardId: string;
  kind: MobileAttentionKind;
  severity: MobileAttentionSeverity;
  sourceKind: string;
  sourceId: string;
  occurredAt: number;
  projectPath: string;
  projectName: string;
  worktreePath?: string | null;
  branchLabel?: string | null;
  terminalType: string;
  title: string;
  detail?: string | null;
  reasonCode: string;
  capability: {
    openRequest: boolean;
    openTerminal: boolean;
    openNotification: boolean;
    openEvidence: boolean;
  };
}

export interface MobileExecutionGroup {
  id: string;
  projectPath: string;
  projectName: string;
  worktreePath: string;
  branchLabel?: string | null;
  cardIds: string[];
  terminalCount: number;
  terminalTypes: string[];
  attentionCount: number;
  status: MobileExecutionContextStatus;
  terminalStatuses: string[];
  lastActivity: number;
  preview?: string | null;
}

export interface MobileWorkbenchProjection {
  generatedAt: number;
  summary: {
    attention: number;
    normalRunning: number;
    review: number;
    failed: number;
  };
  attentionItems: MobileAttentionItem[];
  executionGroups: MobileExecutionGroup[];
  rules: {
    includeWaiting: boolean;
    includeFailed: boolean;
    includeCompletedReview: boolean;
    stalledEnabled: boolean;
    stalledThresholdMinutes: number;
    stalledExcludedCount: number;
  };
  capabilities: {
    openTerminal: boolean;
    respondToStructuredRequest: boolean;
    updateRules: boolean;
    updateNotificationReadState: boolean;
  };
}

export interface TerminalSnapshotMessage {
  cardId: string;
  data: string;
  seq: number;
  runtimeId?: string;
  streamSeq?: number;
  rows: number;
  cols: number;
  cursorRow: number;
  cursorCol: number;
  history?: string;
}

export type ClientCommand =
  | { kind: 'auth'; token: string }
  | { kind: 'subscribe'; card_ids?: string[] }
  | { kind: 'input'; card_id: string; data: string }
  | { kind: 'resize'; card_id: string; cols: number; rows: number }
  | {
      kind: 'spawn';
      request_id: string;
      terminal_type: string;
      project_path: string;
      command?: string;
    }
  | { kind: 'activate'; request_id: string; card_id: string }
  | { kind: 'close'; request_id?: string; card_id: string }
  | { kind: 'pin'; card_id: string; pinned: boolean }
  | { kind: 'set_intent'; card_id: string; intent: string | null }
  | { kind: 'mark_read'; card_id: string }
  | { kind: 'rename_card'; request_id: string; card_id: string; project_name: string }
  | { kind: 'terminal_resync' }
  | { kind: 'ping' };

export type ClientMessage = VersionedBridgeMessage & ClientCommand;

export const CLIENT_MESSAGE_KINDS = [
  'auth',
  'subscribe',
  'input',
  'resize',
  'spawn',
  'activate',
  'close',
  'pin',
  'set_intent',
  'mark_read',
  'rename_card',
  'terminal_resync',
  'ping',
] as const satisfies readonly ClientCommand['kind'][];

export type ServerCommand =
  | {
      kind: 'snapshot';
      cards: CardMeta[];
      notifications: NotificationEntry[];
      workbench?: MobileWorkbenchProjection | null;
      warmingUp?: boolean;
      runtimeId?: string;
      streamSeq?: number;
    }
  | { kind: 'card_added' | 'card_updated' | 'card_removed'; card: CardMeta }
  | {
      kind: 'preview';
      card_id: string;
      last_reply_preview: string;
      summary_line: string | null;
      hidden_line_count: number;
    }
  | { kind: 'terminal_snapshot'; snapshot: TerminalSnapshotMessage }
  | {
      kind: 'terminal_output';
      card_id: string;
      data: string;
      seq: number;
      runtimeId?: string;
      streamSeq?: number;
    }
  | {
      kind: 'theme';
      app: AppThemeTokens;
      terminal: TerminalThemeTokens;
      mode: ResolvedThemeMode;
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
  | {
      kind: 'spawn_result' | 'activate_result' | 'close_result' | 'rename_result';
      request_id: string;
      ok: boolean;
      card_id?: string | null;
      error_code?: string | null;
      message?: string | null;
    }
  | { kind: 'pong'; t: number }
  | { kind: 'error'; code: string; message: string };

export type ServerMessage = VersionedBridgeMessage & ServerCommand;

export const SERVER_MESSAGE_KINDS = [
  'snapshot',
  'card_added',
  'card_updated',
  'card_removed',
  'preview',
  'terminal_snapshot',
  'terminal_output',
  'theme',
  'state',
  'attention',
  'exit',
  'notification',
  'spawn_result',
  'activate_result',
  'close_result',
  'rename_result',
  'pong',
  'error',
] as const satisfies readonly ServerCommand['kind'][];
