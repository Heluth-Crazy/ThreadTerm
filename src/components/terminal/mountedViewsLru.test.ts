import { describe, expect, it } from 'vitest';
import { MAX_MOUNTED_TERMINAL_VIEWS, touchMountedId } from './mountedViewsLru';

describe('touchMountedId', () => {
  it('adds a new id to the tail of an empty array', () => {
    const result = touchMountedId([], 'a', 6, null);
    expect(result.next).toEqual(['a']);
    expect(result.evicted).toEqual([]);
  });

  it('moves an existing id to the tail without duplicating it', () => {
    const result = touchMountedId(['a', 'b', 'c'], 'a', 6, null);
    expect(result.next).toEqual(['b', 'c', 'a']);
    expect(result.evicted).toEqual([]);
  });

  it('keeps the array unchanged in membership when touching the current tail', () => {
    const result = touchMountedId(['a', 'b'], 'b', 6, null);
    expect(result.next).toEqual(['a', 'b']);
    expect(result.evicted).toEqual([]);
  });

  it('evicts from the LRU end (head) when over cap', () => {
    const result = touchMountedId(['a', 'b', 'c'], 'd', 3, null);
    expect(result.next).toEqual(['b', 'c', 'd']);
    expect(result.evicted).toEqual(['a']);
  });

  it('evicts multiple oldest entries when far over cap', () => {
    const result = touchMountedId(['a', 'b', 'c', 'd'], 'e', 2, null);
    expect(result.next).toEqual(['d', 'e']);
    expect(result.evicted).toEqual(['a', 'b', 'c']);
  });

  it('never evicts the protected id, skipping to the next-oldest entry', () => {
    const result = touchMountedId(['a', 'b', 'c'], 'd', 3, 'a');
    expect(result.next).toEqual(['a', 'c', 'd']);
    expect(result.evicted).toEqual(['b']);
  });

  it('never evicts the just-touched id', () => {
    // cap=1 with a protected other entry: 'b' is the touched id, 'a' is
    // protected — neither may be evicted even though we are over cap.
    const result = touchMountedId(['a'], 'b', 1, 'a');
    expect(result.next).toEqual(['a', 'b']);
    expect(result.evicted).toEqual([]);
  });

  it('allows temporarily exceeding cap when all entries are protected', () => {
    // Touched id and protected id are both unevictable, so the result stays
    // over cap rather than evicting a protected view.
    const result = touchMountedId(['a', 'b'], 'b', 1, 'a');
    expect(result.next).toEqual(['a', 'b']);
    expect(result.evicted).toEqual([]);
  });

  it('treats protectedId equal to the touched id without over-protecting others', () => {
    const result = touchMountedId(['a', 'b', 'c'], 'c', 3, 'c');
    expect(result.next).toEqual(['a', 'b', 'c']);
    expect(result.evicted).toEqual([]);

    const overCap = touchMountedId(['a', 'b', 'c'], 'd', 3, 'd');
    expect(overCap.next).toEqual(['b', 'c', 'd']);
    expect(overCap.evicted).toEqual(['a']);
  });

  it('does not mutate the input array', () => {
    const current = ['a', 'b', 'c'];
    touchMountedId(current, 'd', 2, null);
    expect(current).toEqual(['a', 'b', 'c']);
  });

  it('exports a cap aligned with MAX_PINNED_CARDS', () => {
    expect(MAX_MOUNTED_TERMINAL_VIEWS).toBe(6);
  });

  it('caps a long history at the default mounted-view budget', () => {
    let state: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      state = touchMountedId(state, `card-${i}`, MAX_MOUNTED_TERMINAL_VIEWS, `card-${i}`).next;
    }
    expect(state).toHaveLength(MAX_MOUNTED_TERMINAL_VIEWS);
    expect(state).toEqual([
      'card-14',
      'card-15',
      'card-16',
      'card-17',
      'card-18',
      'card-19',
    ]);
  });
});
