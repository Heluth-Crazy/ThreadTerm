import { renderHook } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useAttentionStore } from '../stores/attentionStore';
import { useBackgroundRunStore } from '../stores/backgroundRunStore';
import { useSessionStatusStore } from '../stores/sessionStatusStore';
import { useTaskStore } from '../stores/taskStore';
import { tasks, type Task } from '../lib/tauri-bridge';

let mockLatestMessage: unknown = null;
let mockMessageSequence = 0;

vi.mock('../contexts/TauriEventContext', () => ({
  useWebSocket: () => ({
    latestMessage: mockLatestMessage,
    messageSequence: mockMessageSequence,
    ws: null,
    sendMessage: vi.fn(),
    getBufferedMessagesSince: vi.fn().mockReturnValue([]),
    isConnected: true,
  }),
}));

describe('useSessionStatusTracker', () => {
  beforeEach(() => {
    useSessionStatusStore.setState({ statuses: {} });
    useAttentionStore.setState({ attentionItems: {}, approvalRequests: {} });
    useBackgroundRunStore.setState({ runs: {} });
    useTaskStore.setState({ tasksByProject: {}, loadingByProject: {}, errorByProject: {} });
    vi.restoreAllMocks();
    vi.spyOn(tasks, 'update').mockImplementation(async (projectPath, id, updates) => {
      const current = useTaskStore.getState().getTaskById(projectPath, id);
      if (!current) {
        throw new Error(`Missing task ${id}`);
      }
      const updatedTask = {
        ...current,
        ...updates,
        updated_at: '2026-04-19T10:05:00.000Z',
      } as Task;
      useTaskStore.setState((state) => ({
        tasksByProject: {
          ...state.tasksByProject,
          [projectPath]: (state.tasksByProject[projectPath] ?? []).map((task) =>
            task.id === id ? updatedTask : task,
          ),
        },
      }));
      return updatedTask;
    });
    mockLatestMessage = null;
    mockMessageSequence = 0;
  });

  async function importAndRender() {
    const { useSessionStatusTracker } = await import('./useSessionStatusTracker');
    return renderHook(() => useSessionStatusTracker());
  }

  it('maps permission requests into attentionStore approval state and background run attention', async () => {
    useBackgroundRunStore.getState().createRun({
      id: 'run-1',
      sessionId: 's1',
      provider: 'claude',
      title: 'Review migration',
      source: 'agent',
      status: 'running',
    });

    mockLatestMessage = {
      type: 'claude-permission-request',
      sessionId: 's1',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    };
    mockMessageSequence = 1;
    await importAndRender();

    expect(useSessionStatusStore.getState().getStatus('s1')).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'permission',
    });
    expect(useAttentionStore.getState().approvalRequests['s1']).toMatchObject({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      status: 'pending',
    });
    expect(useAttentionStore.getState().getActiveAttentionItems()).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        reason: 'permission',
        requestId: 'req-1',
      }),
    ]);
    expect(useBackgroundRunStore.getState().runs['run-1']).toMatchObject({
      status: 'needs_attention',
      requiresApproval: true,
      attentionReason: 'approval',
    });
  });

  it('clears approval state and completes the background run when the session completes', async () => {
    useAttentionStore.getState().upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      sessionId: 's1',
    });
    useSessionStatusStore.getState().setNeedsAttention('s1', 'permission');
    useBackgroundRunStore.getState().createRun({
      id: 'run-1',
      sessionId: 's1',
      provider: 'claude',
      title: 'Review migration',
      source: 'agent',
      status: 'needs_attention',
      requiresApproval: true,
    });

    mockLatestMessage = { type: 'claude-complete', sessionId: 's1' };
    mockMessageSequence = 1;
    await importAndRender();

    expect(useSessionStatusStore.getState().getStatus('s1')).toMatchObject({
      status: 'completed',
      attentionReason: undefined,
    });
    expect(useAttentionStore.getState().approvalRequests['s1']).toBeUndefined();
    expect(useBackgroundRunStore.getState().runs['run-1']).toMatchObject({
      status: 'completed',
      requiresApproval: false,
      awaitingInput: false,
    });
  });

  it('resumes runtime state when a pending approval is cancelled', async () => {
    useAttentionStore.getState().upsertApprovalRequest({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      sessionId: 's1',
    });
    useSessionStatusStore.getState().setNeedsAttention('s1', 'permission');
    useBackgroundRunStore.getState().createRun({
      id: 'run-1',
      sessionId: 's1',
      provider: 'claude',
      title: 'Review migration',
      source: 'agent',
      status: 'needs_attention',
      requiresApproval: true,
    });

    mockLatestMessage = { type: 'claude-permission-cancelled', sessionId: 's1' };
    mockMessageSequence = 1;
    await importAndRender();

    expect(useAttentionStore.getState().approvalRequests['s1']).toMatchObject({ status: 'expired' });
    expect(useSessionStatusStore.getState().getStatus('s1')).toMatchObject({ status: 'processing' });
    expect(useBackgroundRunStore.getState().runs['run-1']).toMatchObject({
      status: 'running',
      requiresApproval: false,
      attentionReason: undefined,
    });
  });

  it('rebinds durable task/session projections when a synthetic session becomes real', async () => {
    useSessionStatusStore.getState().setProcessing('synthetic-session', 'claude');
    useTaskStore.setState({
      tasksByProject: {
        '/tmp/project': [
          {
            id: 'task-1',
            title: 'Run task',
            description: 'Run task',
            prompt: 'Run task',
            status: 'in_progress',
            provider: 'claude',
            execution_strategy: 'current_project',
            project_path: '/tmp/project',
            created_at: '2026-04-19T10:00:00.000Z',
            updated_at: '2026-04-19T10:00:00.000Z',
            deps: [],
            session_id: 'synthetic-session',
            review_required: false,
          },
        ],
      },
    });
    useBackgroundRunStore.getState().createRun({
      id: 'run-1',
      sessionId: 'synthetic-session',
      processRef: 'synthetic-session',
      provider: 'claude',
      title: 'Run task',
      source: 'task-queue',
      status: 'running',
    });

    mockLatestMessage = {
      type: 'session-created',
      sessionId: 'real-session',
      originalSessionId: 'synthetic-session',
    };
    mockMessageSequence = 1;
    await importAndRender();

    expect(useTaskStore.getState().getTaskById('/tmp/project', 'task-1')).toMatchObject({
      session_id: 'real-session',
    });
    expect(useSessionStatusStore.getState().statuses['synthetic-session']).toBeUndefined();
    expect(useSessionStatusStore.getState().getStatus('real-session')).toMatchObject({
      status: 'processing',
      taskId: 'task-1',
    });
    expect(useBackgroundRunStore.getState().runs['run-1']).toMatchObject({
      sessionId: 'real-session',
      processRef: 'real-session',
    });
  });
});
