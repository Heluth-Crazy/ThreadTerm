import { describe, expect, it } from 'vitest';
import type { Task } from './tauri-bridge';
import { describeTaskMainPath, formatTaskMainPathBadgeLabel, resolveTaskMainPathAction } from './task-main-path';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Main path task',
    description: 'Main path task',
    prompt: 'Main path task',
    status: 'queued',
    provider: 'codex',
    execution_strategy: 'current_project',
    project_path: '/tmp/project',
    created_at: '2026-04-21T09:00:00.000Z',
    updated_at: '2026-04-21T09:00:00.000Z',
    deps: [],
    review_required: false,
    ...overrides,
  };
}

describe('task main-path helpers', () => {
  it('routes approval and result states into Mission Control surfaces before session fallbacks', () => {
    expect(resolveTaskMainPathAction(
      makeTask({
        status: 'in_progress',
        session_id: 'approval-session',
      }),
      {
        pendingApprovalSessionIds: new Set(['approval-session']),
      },
    )).toEqual({
      kind: 'surface',
      label: 'Open Approval Inbox',
      surfaceTarget: 'approval-inbox',
      focusLocator: {
        sessionId: 'approval-session',
      },
    });

    expect(resolveTaskMainPathAction(
      makeTask({
        id: 'result-task',
        status: 'done',
        result_summary: 'Completed result',
      }),
    )).toEqual({
      kind: 'surface',
      label: 'Open Result Inbox',
      surfaceTarget: 'result-inbox',
      focusLocator: {
        taskId: 'result-task',
      },
    });
  });

  it('falls back to the runtime session when approval or result surfaces are no longer the visible main path', () => {
    expect(resolveTaskMainPathAction(
      makeTask({
        id: 'task-stale-approval',
        status: 'pending_approval',
        session_id: 'runtime-session',
      }),
      {
        pendingApprovalSessionIds: new Set(),
        availableSessionIds: new Set(['runtime-session']),
      },
    )).toEqual({
      kind: 'session',
      label: 'Open Session',
      sessionId: 'runtime-session',
    });

    expect(resolveTaskMainPathAction(
      makeTask({
        id: 'task-hidden-result',
        status: 'done',
        session_id: 'result-session',
        result_summary: 'Completed result',
      }),
      {
        resultTaskIds: new Set(),
        availableSessionIds: new Set(['result-session']),
      },
    )).toEqual({
      kind: 'session',
      label: 'Open Session',
      sessionId: 'result-session',
    });
  });

  it('routes pre-runtime handoff tasks into background runs instead of back to the source session', () => {
    expect(resolveTaskMainPathAction(
      makeTask({
        id: 'handoff-task',
        status: 'dispatched',
        execution_strategy: 'handoff',
        source_session_id: 'source-session',
      }),
      {
        backgroundRunId: 'run-starting',
      },
    )).toEqual({
      kind: 'surface',
      label: 'Open Background Runs',
      surfaceTarget: 'background-runs',
      focusLocator: {
        runId: 'run-starting',
      },
    });
  });

  it('keeps direct-dispatch tasks on background runs until the runtime session is actually available', () => {
    expect(resolveTaskMainPathAction(
      makeTask({
        id: 'worktree-task',
        status: 'in_progress',
        execution_strategy: 'worktree',
        session_id: 'synthetic-runtime',
      }),
      {
        backgroundRunId: 'run-starting',
        availableSessionIds: new Set(['different-session']),
      },
    )).toEqual({
      kind: 'surface',
      label: 'Open Background Runs',
      surfaceTarget: 'background-runs',
      focusLocator: {
        runId: 'run-starting',
      },
    });

    expect(resolveTaskMainPathAction(
      makeTask({
        id: 'worktree-task',
        status: 'in_progress',
        execution_strategy: 'worktree',
        session_id: 'real-runtime',
      }),
      {
        backgroundRunId: 'run-starting',
        availableSessionIds: new Set(['real-runtime']),
      },
    )).toEqual({
      kind: 'session',
      label: 'Open Session',
      sessionId: 'real-runtime',
    });
  });

  it('keeps handoff runtime sessions distinct and routes pre-runtime handoffs back into Task Queue', () => {
    expect(resolveTaskMainPathAction(
      makeTask({
        execution_strategy: 'handoff',
        status: 'in_progress',
        session_id: 'runtime-session',
        source_session_id: 'source-session',
      }),
    )).toEqual({
      kind: 'session',
      label: 'Open Handoff Session',
      sessionId: 'runtime-session',
    });

    expect(resolveTaskMainPathAction(
      makeTask({
        execution_strategy: 'handoff',
        status: 'queued',
        source_session_id: 'source-session',
      }),
    )).toEqual({
      kind: 'task-queue',
      label: 'Open Handoff Task',
    });
  });

  it('projects shared background-run and handoff badges for main-path surfaces', () => {
    expect(describeTaskMainPath(
      makeTask({
        id: 'handoff-task',
        status: 'dispatched',
        execution_strategy: 'handoff',
        source_session_id: 'source-session',
      }),
      {
        backgroundRunId: 'run-starting',
      },
    )).toMatchObject({
      badge: {
        kind: 'surface',
        label: 'Background Runs',
        surfaceTarget: 'background-runs',
      },
    });

    expect(describeTaskMainPath(
      makeTask({
        execution_strategy: 'handoff',
        status: 'queued',
        source_session_id: 'source-session',
      }),
    )).toMatchObject({
      badge: {
        kind: 'path',
        label: 'Handoff',
      },
    });
  });

  it('formats main-path badges consistently across task surfaces', () => {
    expect(formatTaskMainPathBadgeLabel({
      kind: 'surface',
      label: 'Background Runs',
      surfaceTarget: 'background-runs',
    })).toBe('Background Runs');

    expect(formatTaskMainPathBadgeLabel({
      kind: 'path',
      label: 'Handoff',
    })).toBe('Handoff');
  });
});
