import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecentTerminalLaunchTraces,
  createTerminalLaunchTrace,
  getRecentTerminalLaunchTraces,
} from './terminalLaunchDiagnostics';

describe('terminal launch diagnostics', () => {
  beforeEach(() => {
    clearRecentTerminalLaunchTraces();
  });

  it('keeps frontend and backend clocks as separate phase domains', () => {
    let clock = 100;
    const trace = createTerminalLaunchTrace({
      ptyId: 'pane-1',
      launchAttemptId: 'attempt-1',
      clock: () => clock,
    });

    expect(trace.mark('uiRequest')).toMatchObject({
      phase: 'uiRequest',
      domain: 'frontend',
      elapsedMs: 0,
    });

    clock = 125;
    expect(
      trace.acceptBackendPhase({
        launchAttemptId: 'attempt-1',
        ptyId: 'pane-1',
        phase: 'openPtyReady',
        elapsedMs: 18,
        domain: 'backend',
      }),
    ).toMatchObject({
      phase: 'openPtyReady',
      domain: 'backend',
      elapsedMs: 18,
    });
  });

  it('filters duplicate and unrelated backend events', () => {
    const trace = createTerminalLaunchTrace({
      ptyId: 'pane-1',
      launchAttemptId: 'attempt-1',
    });
    const payload = {
      launchAttemptId: 'attempt-1',
      ptyId: 'pane-1',
      phase: 'childSpawned' as const,
      elapsedMs: 4,
      domain: 'backend' as const,
    };

    expect(trace.acceptBackendPhase(payload)).not.toBeNull();
    expect(trace.acceptBackendPhase(payload)).toBeNull();
    expect(
      trace.acceptBackendPhase({ ...payload, launchAttemptId: 'other' }),
    ).toBeNull();
    expect(trace.records()).toHaveLength(1);
  });

  it('retains only a bounded set of completed traces', () => {
    for (let index = 0; index < 70; index += 1) {
      const trace = createTerminalLaunchTrace({ ptyId: `pane-${index}` });
      trace.mark('connected');
    }

    expect(getRecentTerminalLaunchTraces()).toHaveLength(64);
    expect(getRecentTerminalLaunchTraces()[0]?.ptyId).toBe('pane-6');
  });
});
