import type { TerminalStatus, TerminalType } from '../../types/terminal';

export type PrimaryView = 'workbench' | 'terminals';

export type AttentionKind =
  | 'approval'
  | 'waiting_input'
  | 'failed'
  | 'review'
  | 'stalled';

export type AttentionSourceKind =
  | 'structured_request'
  | 'supervisor_alert'
  | 'notification'
  | 'terminal_state';

export type AttentionSeverity = 'info' | 'warning' | 'critical';

export interface AttentionCapability {
  openRequest: boolean;
  openTerminal: boolean;
  openNotification: boolean;
  openEvidence: boolean;
}

export interface AttentionItem {
  id: string;
  cardId: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  sourceKind: AttentionSourceKind;
  sourceId: string;
  occurredAt: number;
  projectPath: string;
  projectName: string;
  worktreePath?: string;
  branchLabel?: string;
  terminalType: TerminalType;
  title: string;
  detail?: string;
  reasonCode:
    | 'structured_approval'
    | 'structured_input'
    | 'supervisor_prompt'
    | 'waiting_state'
    | 'failed_state'
    | 'completed_unread'
    | 'stalled_running';
  capability: AttentionCapability;
}

export type WorkbenchAttentionFilter =
  | 'all'
  | 'approval'
  | 'waiting'
  | 'failed'
  | 'review'
  | 'stalled';

export type WorkbenchViewFilter = WorkbenchAttentionFilter | 'running';

export interface WorkbenchRules {
  includeWaiting: boolean;
  includeFailed: boolean;
  includeCompletedReview: boolean;
  stalledEnabled: boolean;
  stalledThresholdMinutes: number;
  stalledExcludedCardIds: string[];
}

export interface WorkbenchSummary {
  attention: number;
  normalRunning: number;
  review: number;
  failed: number;
}

export interface ProjectWorkbenchOverview {
  projectPath: string;
  projectName: string;
  followedCount: number;
  runningCount: number;
  attentionCount: number;
  reviewCount: number;
  failedCount: number;
}

export interface WorkbenchScopeAttentionCounts {
  byProjectPath: Record<string, number>;
  byWorktreeKey: Record<string, number>;
}

export type ExecutionContextStatus =
  | 'failed'
  | 'attention'
  | 'stalled'
  | 'running'
  | 'review'
  | 'idle';

export interface ExecutionContextGroup {
  id: string;
  projectPath: string;
  projectName: string;
  worktreePath: string;
  branchLabel?: string;
  cardIds: string[];
  terminalCount: number;
  terminalTypes: TerminalType[];
  attentionCount: number;
  status: ExecutionContextStatus;
  terminalStatuses: TerminalStatus[];
  lastActivity: number;
  preview?: string;
}

export type WorkbenchPanelState =
  | { kind: 'attention'; attentionId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'rules' };
