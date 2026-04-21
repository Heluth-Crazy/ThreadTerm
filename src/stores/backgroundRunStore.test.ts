import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBackgroundRunStore } from './backgroundRunStore';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-19T10:00:00.000Z'));
  useBackgroundRunStore.setState({ runs: {} });
});

describe('backgroundRunStore', () => {
  it('createRun makes the run visible in active runs', () => {
    const store = useBackgroundRunStore.getState();

    store.createRun({
      id: 'run-1',
      provider: 'codex',
      title: 'Index project docs',
      source: 'mission-control',
    });

    expect(store.getActiveRuns()).toEqual([
      expect.objectContaining({
        id: 'run-1',
        status: 'queued',
        provider: 'codex',
        title: 'Index project docs',
      }),
    ]);
  });

  it('markRunCompleted moves a run from active to recent completed', () => {
    const store = useBackgroundRunStore.getState();

    store.createRun({
      id: 'run-1',
      provider: 'claude',
      title: 'Summarize logs',
      source: 'agent',
    });

    store.markRunCompleted('run-1', 'Finished successfully');

    expect(store.getActiveRuns()).toEqual([]);
    expect(store.getRecentCompletedRuns()).toEqual([
      expect.objectContaining({
        id: 'run-1',
        status: 'completed',
        summary: 'Finished successfully',
        finishedAt: '2026-04-19T10:00:00.000Z',
      }),
    ]);
  });

  it('updateRun patches the existing run metadata without replacing the run id', () => {
    const store = useBackgroundRunStore.getState();

    store.createRun({
      id: 'run-1',
      taskId: 'task-1',
      provider: 'claude',
      title: 'Dispatch review worker',
      source: 'task-queue',
      status: 'starting',
      sessionId: 'synthetic-session',
    });

    store.updateRun('run-1', {
      sessionId: 'real-session',
      processRef: 'real-session',
      status: 'running',
    });

    expect(useBackgroundRunStore.getState().runs['run-1']).toMatchObject({
      id: 'run-1',
      sessionId: 'real-session',
      processRef: 'real-session',
      status: 'running',
    });
  });

  it('markRunFailed gives the run needs-attention semantics', () => {
    const store = useBackgroundRunStore.getState();

    store.createRun({
      id: 'run-1',
      provider: 'codex',
      title: 'Deploy review worker',
      source: 'manual',
    });

    store.markRunFailed('run-1', 'Agent exited with code 1');

    expect(store.getNeedsAttentionRuns()).toEqual([
      expect.objectContaining({
        id: 'run-1',
        status: 'failed',
        attentionReason: 'error',
        lastOutputExcerpt: 'Agent exited with code 1',
      }),
    ]);
    expect(store.getActiveRuns()).toEqual([]);
  });

  it('resolves the latest linked run for a task and can transition it by task id', () => {
    const store = useBackgroundRunStore.getState();

    store.createRun({
      id: 'run-old',
      taskId: 'task-1',
      provider: 'claude',
      title: 'Old run',
      source: 'task-queue',
      status: 'completed',
      startedAt: '2026-04-19T09:00:00.000Z',
      finishedAt: '2026-04-19T09:30:00.000Z',
    });
    store.createRun({
      id: 'run-new',
      taskId: 'task-1',
      provider: 'claude',
      title: 'New run',
      source: 'task-queue',
      status: 'running',
      startedAt: '2026-04-19T10:00:00.000Z',
    });

    expect(store.getRunByTaskId('task-1')).toMatchObject({ id: 'run-new', status: 'running' });

    store.markRunCompletedForTask('task-1', 'Completed by task link');

    expect(store.getActiveRuns()).toEqual([]);
    expect(useBackgroundRunStore.getState().runs['run-old']).toMatchObject({
      id: 'run-old',
      status: 'completed',
    });
    expect(useBackgroundRunStore.getState().runs['run-new']).toMatchObject({
      id: 'run-new',
      status: 'completed',
      summary: 'Completed by task link',
      finishedAt: '2026-04-19T10:00:00.000Z',
    });
  });

  it('can cancel the currently active linked run for a task id', () => {
    const store = useBackgroundRunStore.getState();

    store.createRun({
      id: 'run-1',
      taskId: 'task-cancel',
      provider: 'codex',
      title: 'Cancelable run',
      source: 'task-queue',
      status: 'needs_attention',
      requiresApproval: true,
    });

    store.markRunCancelledForTask('task-cancel', 'Cancelled');

    expect(store.getActiveRuns()).toEqual([]);
    expect(store.getRecentCompletedRuns()).toEqual([
      expect.objectContaining({
        id: 'run-1',
        taskId: 'task-cancel',
        status: 'cancelled',
        summary: 'Cancelled',
        requiresApproval: false,
      }),
    ]);
  });
});
