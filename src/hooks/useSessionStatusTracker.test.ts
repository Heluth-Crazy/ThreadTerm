import { renderHook } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useSessionStatusStore } from '../stores/sessionStatusStore';

// Module-level variables the mock reads at call time
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

describe('useSessionStatusTracker — WS message mapping', () => {
  beforeEach(() => {
    useSessionStatusStore.setState({ statuses: {}, pendingPermissions: {} });
    mockLatestMessage = null;
    mockMessageSequence = 0;
  });

  async function importAndRender() {
    // Dynamic import to ensure mock is applied
    const { useSessionStatusTracker } = await import('./useSessionStatusTracker');
    return renderHook(() => useSessionStatusTracker());
  }

  it('C1: session-created → processing', async () => {
    mockLatestMessage = { type: 'session-created', sessionId: 's1' };
    mockMessageSequence = 1;
    await importAndRender();

    expect(useSessionStatusStore.getState().getStatus('s1').status).toBe('processing');
  });

  it('C2: claude-response → processing, provider=claude', async () => {
    mockLatestMessage = { type: 'claude-response', sessionId: 's1' };
    mockMessageSequence = 1;
    await importAndRender();

    const entry = useSessionStatusStore.getState().getStatus('s1');
    expect(entry.status).toBe('processing');
    expect(entry.provider).toBe('claude');
  });

  it('C3: codex-response → processing, provider=codex', async () => {
    mockLatestMessage = { type: 'codex-response', sessionId: 's1' };
    mockMessageSequence = 1;
    await importAndRender();

    const entry = useSessionStatusStore.getState().getStatus('s1');
    expect(entry.status).toBe('processing');
    expect(entry.provider).toBe('codex');
  });

  it('C4: claude-complete → completed', async () => {
    mockLatestMessage = { type: 'claude-complete', sessionId: 's1' };
    mockMessageSequence = 1;
    await importAndRender();

    expect(useSessionStatusStore.getState().getStatus('s1').status).toBe('completed');
  });

  it('C5: claude-error → needs_attention(error)', async () => {
    mockLatestMessage = { type: 'claude-error', sessionId: 's1' };
    mockMessageSequence = 1;
    await importAndRender();

    const entry = useSessionStatusStore.getState().getStatus('s1');
    expect(entry.status).toBe('needs_attention');
    expect(entry.attentionReason).toBe('error');
  });

  it('C6: claude-permission-request → needs_attention(permission)', async () => {
    mockLatestMessage = { type: 'claude-permission-request', sessionId: 's1' };
    mockMessageSequence = 1;
    await importAndRender();

    const entry = useSessionStatusStore.getState().getStatus('s1');
    expect(entry.status).toBe('needs_attention');
    expect(entry.attentionReason).toBe('permission');
  });

  it('C6b: claude-permission-request → stores pendingPermission', async () => {
    mockLatestMessage = {
      type: 'claude-permission-request',
      sessionId: 's1',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    };
    mockMessageSequence = 1;
    await importAndRender();

    const pending = useSessionStatusStore.getState().pendingPermissions['s1'];
    expect(pending).toBeDefined();
    expect(pending.requestId).toBe('req-1');
    expect(pending.toolName).toBe('Bash');
    expect(pending.input).toEqual({ command: 'ls' });
  });

  it('C6c: claude-complete clears pendingPermission', async () => {
    useSessionStatusStore.getState().setPendingPermission('s1', {
      requestId: 'r1', toolName: 'Bash', input: {}, sessionId: 's1',
    });
    mockLatestMessage = { type: 'claude-complete', sessionId: 's1' };
    mockMessageSequence = 1;
    await importAndRender();

    expect(useSessionStatusStore.getState().pendingPermissions['s1']).toBeUndefined();
  });

  it('C6d: claude-permission-cancelled clears pendingPermission', async () => {
    useSessionStatusStore.getState().setPendingPermission('s1', {
      requestId: 'r1', toolName: 'Bash', input: {}, sessionId: 's1',
    });
    mockLatestMessage = { type: 'claude-permission-cancelled', sessionId: 's1' };
    mockMessageSequence = 1;
    await importAndRender();

    expect(useSessionStatusStore.getState().pendingPermissions['s1']).toBeUndefined();
  });

  it('C7: session-aborted → needs_attention(aborted)', async () => {
    mockLatestMessage = { type: 'session-aborted', sessionId: 's1' };
    mockMessageSequence = 1;
    await importAndRender();

    const entry = useSessionStatusStore.getState().getStatus('s1');
    expect(entry.status).toBe('needs_attention');
    expect(entry.attentionReason).toBe('aborted');
  });

  it('C8: message without sessionId is ignored', async () => {
    // Pre-set a known state
    useSessionStatusStore.getState().setProcessing('s1', 'claude');

    mockLatestMessage = { type: 'claude-error' }; // no sessionId
    mockMessageSequence = 1;
    await importAndRender();

    // s1 should remain unchanged
    expect(useSessionStatusStore.getState().getStatus('s1').status).toBe('processing');
    // No new entries created
    expect(Object.keys(useSessionStatusStore.getState().statuses)).toEqual(['s1']);
  });
});
