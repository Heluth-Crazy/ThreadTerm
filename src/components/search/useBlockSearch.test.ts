import { describe, expect, it, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBlockSearch } from './useBlockSearch';
import type { Block, TerminalCard } from '../../types/terminal';

const cards: TerminalCard[] = [
  { id: 'c1', projectName: 'p', projectPath: '/p' } as TerminalCard,
];
const small: Record<string, Block[]> = {
  c1: [
    { id: 'b1', cardId: 'c1', cwd: '/p', command: 'echo foo', startedAt: 0, bufferStart: 0, state: 'success' },
    { id: 'b2', cardId: 'c1', cwd: '/p', command: 'echo bar', startedAt: 0, bufferStart: 0, state: 'success' },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useBlockSearch', () => {
  it('returns empty matches for empty query', () => {
    const { result } = renderHook(() => useBlockSearch({ cards, blocks: small, query: '' }));
    expect(result.current.matches).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('returns synchronous matches for small block set', async () => {
    const { result, rerender } = renderHook(
      ({ q }) => useBlockSearch({ cards, blocks: small, query: q }),
      { initialProps: { q: '' } },
    );
    expect(result.current.matches).toEqual([]);
    rerender({ q: 'foo' });
    await waitFor(() => {
      expect(result.current.matches.length).toBe(1);
      expect(result.current.matches[0].block.id).toBe('b1');
    });
  });

  it('updates results when query changes', async () => {
    const { result, rerender } = renderHook(
      ({ q }) => useBlockSearch({ cards, blocks: small, query: q }),
      { initialProps: { q: 'foo' } },
    );
    await waitFor(() => expect(result.current.matches.length).toBe(1));
    rerender({ q: 'bar' });
    await waitFor(() => {
      expect(result.current.matches.length).toBe(1);
      expect(result.current.matches[0].block.id).toBe('b2');
    });
  });

  it('returns no matches when nothing in store matches', async () => {
    const { result } = renderHook(() =>
      useBlockSearch({ cards, blocks: small, query: 'zzz-nope' }),
    );
    await waitFor(() => {
      expect(result.current.matches).toEqual([]);
      expect(result.current.loading).toBe(false);
    });
  });

  it('falls back to sync when Worker is unavailable for >5000 blocks', async () => {
    const big: Record<string, Block[]> = { c1: [] };
    for (let i = 0; i < 5500; i++) {
      big.c1.push({
        id: `b${i}`,
        cardId: 'c1',
        cwd: '/x',
        command: `cmd ${i}`,
        startedAt: 0,
        bufferStart: 0,
        state: 'success',
      });
    }
    const { result } = renderHook(() => useBlockSearch({ cards, blocks: big, query: 'cmd 1234' }));
    await waitFor(() => {
      expect(result.current.matches.length).toBeGreaterThan(0);
      expect(result.current.matches[0].block.id).toBe('b1234');
    });
  });
});
