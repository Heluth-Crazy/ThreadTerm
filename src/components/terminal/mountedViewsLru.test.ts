import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WARM_SURFACE_LIMIT,
  isTerminalSurfacePoolEnabled,
  MAX_MOUNTED_TERMINAL_VIEWS,
  touchMountedId,
  touchMountedSurfaces,
} from './mountedViewsLru';

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
    const result = touchMountedId(['a'], 'b', 1, 'a');
    expect(result.next).toEqual(['a', 'b']);
    expect(result.evicted).toEqual([]);
  });

  it('allows temporarily exceeding cap when all entries are protected', () => {
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

describe('touchMountedSurfaces (visible + warm pool)', () => {
  it('defaults warm limit to one hidden surface', () => {
    expect(DEFAULT_WARM_SURFACE_LIMIT).toBe(1);
  });

  it('keeps all visible surfaces and only one warm when the pool is enabled', () => {
    const result = touchMountedSurfaces(['a', 'b', 'c', 'd'], 'e', {
      visibleIds: ['e'],
      poolEnabled: true,
      warmLimit: 1,
    });
    // e is visible+touched; one warm remains from the previous LRU tail.
    expect(result.next).toContain('e');
    expect(result.next).toHaveLength(2);
    expect(result.evicted).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(result.evicted).toHaveLength(3);
  });

  it('never cold-evicts a float-visible card even when it is not focused', () => {
    const result = touchMountedSurfaces(['focus', 'float', 'old1', 'old2'], 'focus', {
      visibleIds: ['focus', 'float'],
      poolEnabled: true,
      warmLimit: 1,
    });
    expect(result.next).toEqual(expect.arrayContaining(['focus', 'float']));
    expect(result.next).toContain('focus');
    expect(result.next).toContain('float');
    // visible(2) + warm(1) = 3
    expect(result.next.length).toBeLessThanOrEqual(3);
    expect(result.next).not.toContain('old1');
  });

  it('falls back to the legacy 6-view cap when the pool flag is off', () => {
    let state: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      state = touchMountedSurfaces(state, `card-${i}`, {
        visibleIds: [`card-${i}`],
        poolEnabled: false,
      }).next;
    }
    expect(state).toHaveLength(MAX_MOUNTED_TERMINAL_VIEWS);
  });

  it('parses rollback flags from env/storage', () => {
    expect(isTerminalSurfacePoolEnabled(undefined, undefined)).toBe(true);
    expect(isTerminalSurfacePoolEnabled('0', undefined)).toBe(false);
    expect(isTerminalSurfacePoolEnabled(undefined, 'false')).toBe(false);
    expect(isTerminalSurfacePoolEnabled('1', '0')).toBe(true);
  });
});
