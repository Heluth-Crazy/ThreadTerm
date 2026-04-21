import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStatusStore } from './sessionStatusStore';

beforeEach(() => {
  useSessionStatusStore.setState({ statuses: {} });
});

// ─── Group A: State Transitions ──────────────────────────────────────────────

describe('sessionStatusStore — state transitions', () => {
  it('A1: idle → processing', () => {
    const { setProcessing, getStatus } = useSessionStatusStore.getState();
    setProcessing('s1', 'claude');
    const entry = getStatus('s1');
    expect(entry.status).toBe('processing');
    expect(entry.provider).toBe('claude');
  });

  it('A2: processing → completed (attentionReason cleared)', () => {
    const store = useSessionStatusStore.getState();
    store.setProcessing('s1', 'claude');
    store.setCompleted('s1');
    const entry = store.getStatus('s1');
    expect(entry.status).toBe('completed');
    expect(entry.attentionReason).toBeUndefined();
  });

  it('A3: processing → needs_attention(error)', () => {
    const store = useSessionStatusStore.getState();
    store.setProcessing('s1', 'claude');
    store.setNeedsAttention('s1', 'error');
    const entry = useSessionStatusStore.getState().getStatus('s1');
    expect(entry.status).toBe('needs_attention');
    expect(entry.attentionReason).toBe('error');
  });

  it('A4: processing → needs_attention(permission)', () => {
    const store = useSessionStatusStore.getState();
    store.setProcessing('s1', 'claude');
    store.setNeedsAttention('s1', 'permission');
    const entry = useSessionStatusStore.getState().getStatus('s1');
    expect(entry.status).toBe('needs_attention');
    expect(entry.attentionReason).toBe('permission');
  });

  it('A5: needs_attention → idle (dismiss)', () => {
    const store = useSessionStatusStore.getState();
    store.setNeedsAttention('s1', 'error');
    store.setIdle('s1');
    const entry = useSessionStatusStore.getState().getStatus('s1');
    expect(entry.status).toBe('idle');
    expect(entry.attentionReason).toBeUndefined();
  });

  it('A6: completed → processing (user sends another message)', () => {
    const store = useSessionStatusStore.getState();
    store.setCompleted('s1');
    store.setProcessing('s1', 'codex');
    const entry = useSessionStatusStore.getState().getStatus('s1');
    expect(entry.status).toBe('processing');
    expect(entry.provider).toBe('codex');
  });

  it('A7: removeSession returns default idle entry', () => {
    const store = useSessionStatusStore.getState();
    store.setProcessing('s1', 'claude');
    store.setRuntimeProjection('s1', {
      taskId: 'task-1',
      taskTitle: 'Refine mission control',
      taskStatus: 'in_progress',
      projectPath: '/tmp/project',
      worktreePath: '/tmp/project',
    });
    store.removeSession('s1');
    const entry = useSessionStatusStore.getState().getStatus('s1');
    expect(entry.status).toBe('idle');
    expect(entry.updatedAt).toBe(0);
    expect(entry.taskId).toBeUndefined();
  });

  it('A7b: rebindSession preserves runtime projection when a synthetic session id is replaced', () => {
    const store = useSessionStatusStore.getState();
    store.setProcessing('synthetic', 'claude');
    store.setRuntimeProjection('synthetic', {
      taskId: 'task-1',
      taskTitle: 'Refine mission control',
      taskStatus: 'in_progress',
      projectPath: '/tmp/project',
      worktreePath: '/tmp/project-wt',
    });

    store.rebindSession('synthetic', 'real-session', 'claude');

    expect(store.statuses.synthetic).toBeUndefined();
    expect(store.getStatus('real-session')).toMatchObject({
      status: 'processing',
      provider: 'claude',
      taskId: 'task-1',
      taskTitle: 'Refine mission control',
      taskStatus: 'in_progress',
      projectPath: '/tmp/project',
      worktreePath: '/tmp/project-wt',
    });
  });

  it('A8: pruneStale removes old completed but keeps old processing', () => {
    const oldTs = Date.now() - 25 * 3600 * 1000;
    useSessionStatusStore.setState({
      statuses: {
        completed1: { status: 'completed', updatedAt: oldTs },
        processing1: { status: 'processing', updatedAt: oldTs, provider: 'claude' },
      },
    });
    useSessionStatusStore.getState().pruneStale();

    const state = useSessionStatusStore.getState();
    expect(state.getStatus('completed1').status).toBe('idle'); // pruned → default
    expect(state.getStatus('processing1').status).toBe('processing'); // kept
  });

  it('A8b: setCompleted does NOT overwrite needs_attention', () => {
    useSessionStatusStore.getState().setNeedsAttention('s1', 'error');
    useSessionStatusStore.getState().setCompleted('s1');
    expect(useSessionStatusStore.getState().getStatus('s1').status).toBe('needs_attention');
  });

  it('A8c: setCompleted(force) overwrites transient needs_attention', () => {
    useSessionStatusStore.getState().setNeedsAttention('s1', 'permission');
    useSessionStatusStore.getState().setCompleted('s1', { force: true });
    const entry = useSessionStatusStore.getState().getStatus('s1');
    expect(entry.status).toBe('completed');
    expect(entry.attentionReason).toBeUndefined();
  });
});

// ─── Group B: Multi-session Isolation ────────────────────────────────────────

describe('sessionStatusStore — multi-session isolation', () => {
  it('B1: multiple sessions maintain independent statuses', () => {
    const store = useSessionStatusStore.getState();
    store.setProcessing('s1', 'claude');
    store.setCompleted('s2');
    store.setNeedsAttention('s3', 'error');

    const state = useSessionStatusStore.getState();
    expect(state.getStatus('s1').status).toBe('processing');
    expect(state.getStatus('s2').status).toBe('completed');
    expect(state.getStatus('s3').status).toBe('needs_attention');
  });

  it('B2: updating one session does not alter another', () => {
    useSessionStatusStore.setState({
      statuses: {
        s1: { status: 'processing', updatedAt: 1000, provider: 'claude' },
        s2: { status: 'completed', updatedAt: 2000 },
      },
    });
    useSessionStatusStore.getState().setNeedsAttention('s1', 'error');

    const s2 = useSessionStatusStore.getState().getStatus('s2');
    expect(s2.updatedAt).toBe(2000);
    expect(s2.status).toBe('completed');
  });

  it('B3: idempotent — calling setProcessing twice does not throw', () => {
    const store = useSessionStatusStore.getState();
    store.setProcessing('s1', 'claude');
    store.setProcessing('s1', 'claude');
    expect(useSessionStatusStore.getState().getStatus('s1').status).toBe('processing');
  });

  it('B4: unknown sessionId returns default idle entry', () => {
    const entry = useSessionStatusStore.getState().getStatus('nonexistent');
    expect(entry).toEqual({ status: 'idle', updatedAt: 0 });
  });
});

// ─── Group E: Integration / Selectors ────────────────────────────────────────

describe('sessionStatusStore — selectors & persistence', () => {
  it('E1: getProcessingSessions returns only processing sessions', () => {
    const store = useSessionStatusStore.getState();
    store.setProcessing('s1', 'claude');
    store.setCompleted('s2');
    store.setProcessing('s3', 'codex');
    store.setNeedsAttention('s4', 'error');

    const processing = useSessionStatusStore.getState().getProcessingSessions();
    expect(processing).toContain('s1');
    expect(processing).toContain('s3');
    expect(processing).not.toContain('s2');
    expect(processing).not.toContain('s4');
    expect(processing).toHaveLength(2);
  });

  it('E2: getAttentionSessions returns only needs_attention sessions', () => {
    const store = useSessionStatusStore.getState();
    store.setProcessing('s1', 'claude');
    store.setNeedsAttention('s2', 'error');
    store.setCompleted('s3');
    store.setNeedsAttention('s4', 'permission');

    const attention = useSessionStatusStore.getState().getAttentionSessions();
    expect(attention).toContain('s2');
    expect(attention).toContain('s4');
    expect(attention).not.toContain('s1');
    expect(attention).not.toContain('s3');
    expect(attention).toHaveLength(2);
  });

  it('F1: persist storage key is openwork-session-status', () => {
    const opts = useSessionStatusStore.persist.getOptions();
    expect(opts.name).toBe('openwork-session-status');
  });
});



