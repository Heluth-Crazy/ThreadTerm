export type TaskTimelineStage = 'backlog' | 'running' | 'review' | 'completed';

export type MissionControlSurfaceTarget =
  | 'attention-inbox'
  | 'approval-inbox'
  | 'review-queue'
  | 'result-inbox'
  | 'background-runs'
  | 'task-backlog'
  | 'task-running'
  | 'task-review'
  | 'task-completed';

export interface MissionControlSurfaceLocator {
  taskId?: string;
  sessionId?: string;
  runId?: string;
}
