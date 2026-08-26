import { describe, expect, it } from 'vitest';
import { OutputSequenceGuard } from './sequencing';

const identity = { runtimeId: 'runtime', handle: 'handle', streamId: 'stream-a', attachId: 'attach-a' };

describe('terminal-host output sequencing', () => {
  it('rejects stale output and requests resync for a sequence gap', () => {
    const guard = new OutputSequenceGuard();
    guard.beginEpoch(identity, 4);
    expect(guard.decide(identity, 5)).toBe('accept');
    expect(guard.decide(identity, 5)).toBe('ignore');
    expect(guard.decide(identity, 7)).toBe('resync');
  });

  it('moves to a new epoch so old attachments cannot paint', () => {
    const guard = new OutputSequenceGuard();
    guard.beginEpoch(identity, 1);
    guard.beginEpoch({ ...identity, streamId: 'stream-b', attachId: 'attach-b' }, 9);
    expect(guard.decide(identity, 2)).toBe('ignore');
    expect(guard.decide({ ...identity, streamId: 'stream-b', attachId: 'attach-b' }, 10)).toBe('accept');
  });
});
