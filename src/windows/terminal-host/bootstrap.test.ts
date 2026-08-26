import { describe, expect, it } from 'vitest';
import { BootstrapEventGuard, matchesSurfaceIdentity } from './bootstrap';
import type { SurfaceBootstrap } from './protocol';

function surface(overrides: Partial<SurfaceBootstrap> = {}): SurfaceBootstrap {
  return {
    runtimeId: 'runtime-a',
    handle: 'handle-a',
    revision: 2,
    placement: 'window',
    presentation: 'background',
    attachId: 'attach-a',
    streamId: 'stream-a',
    barrierSeq: 4,
    snapshot: {
      contentBase64: '',
      rows: 24,
      cols: 80,
      cursorRow: 0,
      cursorCol: 0,
    },
    ...overrides,
  };
}

describe('terminal-host bootstrap event guard', () => {
  it('rejects the same delivered epoch twice', () => {
    const guard = new BootstrapEventGuard();
    const bootstrap = surface();
    expect(guard.take(bootstrap)).toBe(true);
    expect(guard.take(bootstrap)).toBe(false);
  });

  it('accepts a newer resync barrier for the same attachment', () => {
    const guard = new BootstrapEventGuard();
    expect(guard.take(surface())).toBe(true);
    expect(guard.take(surface({ barrierSeq: 9 }))).toBe(true);
  });

  it('accepts a transferred surface identity', () => {
    const guard = new BootstrapEventGuard();
    expect(guard.take(surface())).toBe(true);
    expect(guard.take(surface({ revision: 3, attachId: 'attach-b' }))).toBe(true);
  });

  it('matches ready confirmation only to the current complete identity', () => {
    const current = surface();
    expect(matchesSurfaceIdentity(current, {
      runtimeId: current.runtimeId,
      handle: current.handle,
      revision: current.revision,
      attachId: current.attachId,
      streamId: current.streamId,
    })).toBe(true);
    expect(matchesSurfaceIdentity(current, {
      runtimeId: current.runtimeId,
      handle: current.handle,
      revision: current.revision + 1,
      attachId: current.attachId,
      streamId: current.streamId,
    })).toBe(false);
  });
});
