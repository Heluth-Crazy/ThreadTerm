import type { TaskExecutionStrategy, TaskRole } from '../lib/tauri-bridge';

export type BackgroundRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'awaiting_input'
  | 'needs_attention'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type BackgroundRunProvider = 'codex' | 'claude' | 'custom';
export type BackgroundRunSource = 'mission-control' | 'task-queue' | 'manual' | 'agent';
export type BackgroundRunAttentionReason = 'approval' | 'error' | 'input' | 'completed';

export interface BackgroundRun {
  id: string;
  taskId?: string;
  provider: BackgroundRunProvider;
  title: string;
  source: BackgroundRunSource;
  status: BackgroundRunStatus;
  projectId?: string;
  sessionId?: string;
  sourceSessionId?: string;
  taskRole?: TaskRole;
  executionStrategy?: TaskExecutionStrategy;
  worktreePath?: string;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
  lastOutputExcerpt?: string;
  attentionReason?: BackgroundRunAttentionReason;
  requiresApproval?: boolean;
  awaitingInput?: boolean;
  processRef?: string;
}

export interface BackgroundRunEvent {
  id: string;
  runId: string;
  type:
    | 'run-created'
    | 'run-started'
    | 'run-progress'
    | 'run-awaiting-input'
    | 'run-approval-requested'
    | 'run-completed'
    | 'run-failed'
    | 'run-cancelled';
  createdAt: string;
  sessionId?: string;
  projectId?: string;
  message?: string;
  excerpt?: string;
}
