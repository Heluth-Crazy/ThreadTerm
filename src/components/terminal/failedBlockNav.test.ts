import { describe, expect, it } from 'vitest';
import { prevFailedBlock, nextFailedBlock } from './failedBlockNav';
import type { Block } from '../../types/terminal';

function makeBlock(id: string, state: Block['state']): Block {
  return {
    id,
    cardId: 'card-1',
    cwd: '/tmp',
    command: `cmd-${id}`,
    startedAt: 0,
    bufferStart: 0,
    state,
  };
}

describe('prevFailedBlock', () => {
  it('returns null for empty block list', () => {
    expect(prevFailedBlock([], null)).toBeNull();
  });

  it('returns null when no failed blocks exist', () => {
    const blocks = [makeBlock('a', 'success'), makeBlock('b', 'running')];
    expect(prevFailedBlock(blocks, null)).toBeNull();
  });

  it('returns the last failed block when currentBlockId is null', () => {
    const blocks = [makeBlock('a', 'failed'), makeBlock('b', 'success'), makeBlock('c', 'failed')];
    expect(prevFailedBlock(blocks, null)).toBe('c');
  });

  it('returns the previous failed block before current', () => {
    const blocks = [makeBlock('a', 'failed'), makeBlock('b', 'success'), makeBlock('c', 'failed')];
    expect(prevFailedBlock(blocks, 'c')).toBe('a');
  });

  it('wraps from the first failed block to the last', () => {
    const blocks = [makeBlock('a', 'failed'), makeBlock('b', 'failed'), makeBlock('c', 'failed')];
    expect(prevFailedBlock(blocks, 'a')).toBe('c');
  });

  it('returns the single failed block when it is also current (wrap)', () => {
    const blocks = [makeBlock('a', 'success'), makeBlock('b', 'failed')];
    expect(prevFailedBlock(blocks, 'b')).toBe('b');
  });

  it('skips non-failed blocks between current and previous failed', () => {
    const blocks = [
      makeBlock('a', 'failed'),
      makeBlock('b', 'running'),
      makeBlock('c', 'success'),
      makeBlock('d', 'failed'),
    ];
    expect(prevFailedBlock(blocks, 'd')).toBe('a');
  });
});

describe('nextFailedBlock', () => {
  it('returns null for empty block list', () => {
    expect(nextFailedBlock([], null)).toBeNull();
  });

  it('returns null when no failed blocks exist', () => {
    const blocks = [makeBlock('a', 'success'), makeBlock('b', 'running')];
    expect(nextFailedBlock(blocks, null)).toBeNull();
  });

  it('returns the first failed block when currentBlockId is null', () => {
    const blocks = [makeBlock('a', 'success'), makeBlock('b', 'failed'), makeBlock('c', 'failed')];
    expect(nextFailedBlock(blocks, null)).toBe('b');
  });

  it('returns the next failed block after current', () => {
    const blocks = [makeBlock('a', 'failed'), makeBlock('b', 'success'), makeBlock('c', 'failed')];
    expect(nextFailedBlock(blocks, 'a')).toBe('c');
  });

  it('wraps from the last failed block to the first', () => {
    const blocks = [makeBlock('a', 'failed'), makeBlock('b', 'failed'), makeBlock('c', 'failed')];
    expect(nextFailedBlock(blocks, 'c')).toBe('a');
  });

  it('returns the single failed block when it is also current (wrap)', () => {
    const blocks = [makeBlock('a', 'failed'), makeBlock('b', 'success')];
    expect(nextFailedBlock(blocks, 'a')).toBe('a');
  });

  it('skips non-failed blocks between current and next failed', () => {
    const blocks = [
      makeBlock('a', 'failed'),
      makeBlock('b', 'running'),
      makeBlock('c', 'success'),
      makeBlock('d', 'failed'),
    ];
    expect(nextFailedBlock(blocks, 'a')).toBe('d');
  });
});
