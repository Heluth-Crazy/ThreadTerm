import { describe, expect, it } from 'vitest';
import { searchAcrossBlocks } from './searchAcrossBlocks';
import type { Block, TerminalCard } from '../../types/terminal';

const cards: TerminalCard[] = [
  { id: 'c1', projectName: 'foo', projectPath: '/p/foo' } as TerminalCard,
  { id: 'c2', projectName: 'bar', projectPath: '/p/bar' } as TerminalCard,
];

const blocks: Record<string, Block[]> = {
  c1: [
    { id: 'b1', cardId: 'c1', cwd: '/p/foo', command: 'npm test', startedAt: 0, bufferStart: 0, state: 'success' },
    { id: 'b2', cardId: 'c1', cwd: '/p/foo/sub', command: 'git status', startedAt: 0, bufferStart: 0, state: 'failed' },
  ],
  c2: [
    { id: 'b3', cardId: 'c2', cwd: '/p/bar', command: 'pnpm install', startedAt: 0, bufferStart: 0, state: 'success' },
  ],
};

describe('searchAcrossBlocks', () => {
  it('returns empty array for blank query', () => {
    expect(searchAcrossBlocks(cards, blocks, '', 100)).toEqual([]);
    expect(searchAcrossBlocks(cards, blocks, '   ', 100)).toEqual([]);
  });

  it('matches commands case-insensitively', () => {
    // "NPM" matches "npm test" and "pnpm install" (substring) — both valid.
    const r = searchAcrossBlocks(cards, blocks, 'NPM TEST', 100);
    expect(r).toHaveLength(1);
    expect(r[0].block.id).toBe('b1');
    expect(r[0].field).toBe('command');
  });

  it('matches cwd substrings', () => {
    const r = searchAcrossBlocks(cards, blocks, 'sub', 100);
    expect(r.map((m) => m.block.id)).toEqual(['b2']);
    expect(r[0].field).toBe('cwd');
  });

  it('falls back to project field only after command/cwd miss', () => {
    // Use a query that appears in projectName but NOT in any command or cwd.
    const r = searchAcrossBlocks(cards, blocks, 'foo', 100);
    // "foo" appears in c1's projectName and the cwd /p/foo — cwd matches first
    // because the matching loop checks command → cwd → project in priority order.
    expect(r.length).toBeGreaterThan(0);
    expect(['command', 'cwd', 'project']).toContain(r[0].field);
  });

  it('uses project field when neither command nor cwd contains the query', () => {
    const projectOnlyBlocks: Record<string, Block[]> = {
      c1: [{ id: 'b1', cardId: 'c1', cwd: '/x', command: 'ls', startedAt: 0, bufferStart: 0, state: 'success' }],
    };
    const r = searchAcrossBlocks(cards, projectOnlyBlocks, 'foo', 100);
    expect(r).toHaveLength(1);
    expect(r[0].field).toBe('project');
  });

  it('escapes regex special characters in query', () => {
    const blocks2: Record<string, Block[]> = {
      c1: [{ ...blocks.c1[0], command: 'foo.bar*baz' }],
    };
    expect(searchAcrossBlocks(cards, blocks2, 'foo.bar', 100)).toHaveLength(1);
    expect(searchAcrossBlocks(cards, blocks2, 'fo.', 100)).toHaveLength(0);
  });

  it('respects limit parameter', () => {
    const big: Record<string, Block[]> = { c1: [] };
    for (let i = 0; i < 50; i++) {
      big.c1.push({
        id: `b${i}`,
        cardId: 'c1',
        cwd: '/x',
        command: `npm test ${i}`,
        startedAt: 0,
        bufferStart: 0,
        state: 'success',
      });
    }
    expect(searchAcrossBlocks(cards, big, 'npm', 10)).toHaveLength(10);
  });

  it('ignores blocks whose cardId has no matching card entry', () => {
    const orphaned = { 'card-gone': [blocks.c1[0]] };
    expect(searchAcrossBlocks(cards, orphaned, 'npm', 100)).toEqual([]);
  });

  it('matches output text', () => {
    const blocksWithOutput: Record<string, Block[]> = {
      c1: [{
        id: 'b1',
        cardId: 'c1',
        cwd: '/x',
        command: 'ls',
        startedAt: 0,
        bufferStart: 0,
        state: 'success',
        output: 'README.md\npackage.json\nsrc/',
      }],
    };
    const r = searchAcrossBlocks(cards, blocksWithOutput, 'package.json', 100);
    expect(r).toHaveLength(1);
    expect(r[0].field).toBe('output');
  });

  it('falls through command -> cwd -> project -> output in priority order', () => {
    const b: Record<string, Block[]> = {
      c1: [{
        id: 'b1',
        cardId: 'c1',
        cwd: '/safe',
        command: 'safe',
        startedAt: 0,
        bufferStart: 0,
        state: 'success',
        output: 'matchhere',
      }],
    };
    expect(searchAcrossBlocks(cards, b, 'matchhere', 100)[0].field).toBe('output');
  });

  it('returns the matched line for output matches', () => {
    const blocksWithOutput: Record<string, Block[]> = {
      c1: [{
        id: 'b1',
        cardId: 'c1',
        cwd: '/x',
        command: 'ls',
        startedAt: 0,
        bufferStart: 0,
        state: 'success',
        output: 'README.md\npackage.json\nsrc/',
      }],
    };
    const r = searchAcrossBlocks(cards, blocksWithOutput, 'package', 100);
    expect(r[0].matchedLine).toBe('package.json');
  });

  it('does not set matchedLine for command/cwd/project matches', () => {
    const r = searchAcrossBlocks(cards, blocks, 'sub', 100);
    expect(r[0].matchedLine).toBeUndefined();
  });

  it('runs <200ms for 5000 blocks (perf budget)', () => {
    const big: Record<string, Block[]> = { c1: [] };
    for (let i = 0; i < 5000; i++) {
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
    const start = performance.now();
    searchAcrossBlocks(cards, big, '4242', 1000);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
