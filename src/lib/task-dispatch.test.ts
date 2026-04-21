import { describe, expect, it } from 'vitest';
import type { Task } from './tauri-bridge';
import {
  buildTaskDispatchPresentation,
  buildTaskDispatchContextLines,
  buildTaskSessionSummaryLine,
  describeTaskExecutionTarget,
  findTaskSessionLink,
  formatPendingHandoffRuntimeLabel,
  formatTaskDispatchTargetLabel,
  getTaskSessionBinding,
  resolveTaskExecutionProjectPath,
  resolveTaskOpenSessionAction,
  resolveTaskRuntimeSessionId,
  resolveTaskSourceSessionId,
} from './task-dispatch';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Queue control-plane dispatch',
    prompt: 'Queue control-plane dispatch',
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

describe('task-dispatch helpers', () => {
  it('separates handoff source and runtime session ids', () => {
    const task = makeTask({
      execution_strategy: 'handoff',
      session_id: 'runtime-session',
      source_session_id: 'source-session',
      status: 'in_progress',
    });

    expect(resolveTaskSourceSessionId(task)).toBe('source-session');
    expect(resolveTaskRuntimeSessionId(task)).toBe('runtime-session');
    expect(getTaskSessionBinding(task, 'source-session')).toBe('source');
    expect(getTaskSessionBinding(task, 'runtime-session')).toBe('runtime');
  });

  it('prefers the active runtime task over older source-linked handoff tasks for a session', () => {
    const linked = findTaskSessionLink(
      [
        makeTask({
          id: 'task-source',
          execution_strategy: 'handoff',
          source_session_id: 'session-1',
          session_id: 'runtime-session',
          status: 'queued',
          updated_at: '2026-04-21T09:00:00.000Z',
        }),
        makeTask({
          id: 'task-runtime',
          session_id: 'session-1',
          status: 'in_progress',
          updated_at: '2026-04-21T10:00:00.000Z',
        }),
      ],
      'session-1',
    );

    expect(linked).toMatchObject({
      task: expect.objectContaining({ id: 'task-runtime' }),
      binding: 'runtime',
    });
  });

  it('keeps a queued handoff visible on its source session before the runtime exists', () => {
    const linked = findTaskSessionLink(
      [
        makeTask({
          id: 'task-handoff',
          execution_strategy: 'handoff',
          source_session_id: 'session-source',
          worktree_path: '/tmp/project-worktrees/review-a',
          status: 'queued',
        }),
      ],
      'session-source',
    );

    expect(linked).toMatchObject({
      task: expect.objectContaining({
        id: 'task-handoff',
        execution_strategy: 'handoff',
        worktree_path: '/tmp/project-worktrees/review-a',
      }),
      binding: 'source',
    });
  });

  it('formats the same handoff session summary used by queue and timeline surfaces', () => {
    const task = makeTask({
      execution_strategy: 'handoff',
      source_session_id: 'session-source',
      session_id: 'session-runtime',
      status: 'in_progress',
    });

    expect(
      buildTaskSessionSummaryLine(
        task,
        { sessionId: 'session-source', subtitle: 'Repo A · Claude', title: 'Source Session' },
        { sessionId: 'session-runtime', subtitle: 'Repo A · Codex', title: 'Runtime Session' },
      ),
    ).toBe('Source session · Repo A · Claude · Source Session · Runtime session · Repo A · Codex · Runtime Session');
  });

  it('resolves worktree-aware execution targets for dispatch and result collection', () => {
    const task = makeTask({
      execution_strategy: 'handoff',
      worktree_path: '/tmp/project-worktrees/review-a',
    });

    expect(resolveTaskExecutionProjectPath(task)).toBe('/tmp/project-worktrees/review-a');
    expect(describeTaskExecutionTarget(task)).toBe('the review-a worktree');
  });

  it('builds stable source/runtime/target context lines for handoff tasks', () => {
    const task = makeTask({
      execution_strategy: 'handoff',
      source_session_id: 'source-session',
      session_id: 'runtime-session',
      worktree_path: '/tmp/project-worktrees/review-a',
      status: 'in_progress',
    });

    expect(buildTaskDispatchContextLines(task, {
      sourceSessionLabel: { subtitle: 'Repo A · Claude', title: 'Source Session' },
      runtimeSessionLabel: { subtitle: 'Repo A · Codex', title: 'Runtime Session' },
    })).toEqual([
      'Source session · Repo A · Claude · Source Session',
      'Runtime session · Repo A · Codex · Runtime Session',
      'Dispatch target · review-a worktree',
    ]);
  });

  it('falls back to local source binding and this-project targets when no worktree is selected', () => {
    const task = makeTask({
      execution_strategy: 'handoff',
      source_session_id: 'source-session',
      status: 'queued',
    });

    expect(buildTaskDispatchContextLines(task, {
      taskSessionBinding: 'source',
    })).toEqual([
      'Source session · This session',
      'Runtime session · Starts when dispatch begins',
      'Dispatch target · This project',
    ]);
    expect(formatTaskDispatchTargetLabel({
      execution_strategy: 'current_project',
      worktree_path: '',
    })).toBe('This project');
  });

  it('describes queued and dispatched handoff runtimes consistently before a runtime session exists', () => {
    expect(formatPendingHandoffRuntimeLabel('queued')).toBe('Starts when dispatch begins');
    expect(formatPendingHandoffRuntimeLabel('dispatched')).toBe('Starting in background');
  });

  it('keeps queued legacy handoff tasks bound to the source session until a runtime exists', () => {
    const task = makeTask({
      execution_strategy: 'handoff',
      session_id: 'session-source',
      status: 'queued',
    });

    expect(resolveTaskOpenSessionAction(task)).toEqual({
      kind: 'source',
      label: 'Open Source Session',
      sessionId: 'session-source',
    });

    expect(buildTaskDispatchPresentation(task, {
      sessionLabelsById: {
        'session-source': {
          title: 'Source Session',
          subtitle: 'Repo A · Claude',
        },
      },
      fallbackWorktreePath: '/tmp/project-worktrees/review-a',
    })).toMatchObject({
      sourceSessionId: 'session-source',
      runtimeSessionId: undefined,
      dispatchTargetLabel: 'Dispatch target · review-a worktree',
      contextDetailLines: [
        'Source session · Repo A · Claude · Source Session',
        'Runtime session · Starts when dispatch begins',
        'Worktree path · project-worktrees/review-a',
      ],
      openSessionAction: {
        kind: 'source',
        label: 'Open Source Session',
        sessionId: 'session-source',
      },
    });
  });
});
