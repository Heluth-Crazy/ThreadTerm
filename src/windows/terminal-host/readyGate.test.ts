import { describe, expect, it } from 'vitest';
import { SurfaceReadyGate } from './readyGate';

describe('terminal-host surface readiness', () => {
  it('waits for both snapshot completion and usable geometry', () => {
    const gate = new SurfaceReadyGate();
    gate.arm('epoch-a');
    expect(gate.takeIfReady('epoch-a', true)).toBe(false);
    gate.markSnapshotWritten('epoch-a');
    expect(gate.takeIfReady('epoch-a', false)).toBe(false);
    expect(gate.takeIfReady('epoch-a', true)).toBe(true);
  });

  it('consumes ready once and re-arms only for a new presentation epoch', () => {
    const gate = new SurfaceReadyGate();
    gate.arm('epoch-a');
    gate.markSnapshotWritten('epoch-a');
    expect(gate.takeIfReady('epoch-a', true)).toBe(true);
    expect(gate.takeIfReady('epoch-a', true)).toBe(false);
    gate.arm('epoch-a');
    expect(gate.takeIfReady('epoch-a', true)).toBe(false);
    gate.arm('epoch-b');
    gate.markSnapshotWritten('epoch-b');
    expect(gate.takeIfReady('epoch-b', true)).toBe(true);
  });

  it('allows a readiness retry after the native handshake fails', () => {
    const gate = new SurfaceReadyGate();
    gate.arm('epoch-a');
    gate.markSnapshotWritten('epoch-a');

    expect(gate.takeIfReady('epoch-a', true)).toBe(true);
    expect(gate.takeIfReady('epoch-a', true)).toBe(false);
    gate.releaseClaim('epoch-a');
    expect(gate.takeIfReady('epoch-a', true)).toBe(true);
  });
});
