import { describe, expect, it } from 'vitest';
import {
  deriveTerminalSurfacePhases,
  getMountedTerminalSurfaces,
  publishMountedTerminalSurfaces,
} from './mountedTerminalSurfaces';

describe('mountedTerminalSurfaces', () => {
  it('publishes a read-only copy of mounted card ids', () => {
    publishMountedTerminalSurfaces({
      mountedCardIds: ['a', 'b'],
      focusedCardId: 'a',
      floatCardId: null,
      maxMountedTerminalViews: 6,
      terminalSurfacePoolEnabled: false,
    });
    const snap = getMountedTerminalSurfaces();
    expect(snap.mountedCardIds).toEqual(['a', 'b']);
    snap.mountedCardIds.push('mutated');
    expect(getMountedTerminalSurfaces().mountedCardIds).toEqual(['a', 'b']);
  });

  it('reports non-visible mounted cards as warm even when the pool flag is off', () => {
    const phases = deriveTerminalSurfacePhases({
      mountedCardIds: ['a', 'b', 'c'],
      focusedCardId: 'a',
      floatCardId: 'b',
      maxMountedTerminalViews: 6,
      terminalSurfacePoolEnabled: false,
    });
    expect(phases.visibleCardIds.sort()).toEqual(['a', 'b']);
    expect(phases.warmCardIds).toEqual(['c']);
    expect(phases.coldCardIds).toEqual([]);
  });

  it('classifies non-visible mounted cards as warm when the pool is on', () => {
    const phases = deriveTerminalSurfacePhases({
      mountedCardIds: ['a', 'b', 'c'],
      focusedCardId: 'a',
      floatCardId: null,
      maxMountedTerminalViews: 2,
      terminalSurfacePoolEnabled: true,
    });
    expect(phases.visibleCardIds).toEqual(['a']);
    expect(phases.warmCardIds).toEqual(['b', 'c']);
  });
});
