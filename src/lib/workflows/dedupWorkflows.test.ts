import { describe, expect, it } from 'vitest';
import {
  classifyApplyEntries,
  normalizeCommand,
  normalizeCwd,
  resolveWorkflowCwd,
  type ExistingCardForDedup,
} from './dedupWorkflows';
import type { Workflow } from './parseWorkflow';

function wf(name: string, command: string, extras: Partial<Workflow> = {}): Workflow & {
  filePath: string;
} {
  return { name, command, ...extras, filePath: `/g/${name}.yaml` };
}

describe('normalizeCwd', () => {
  it('strips trailing slashes', () => {
    expect(normalizeCwd('/a/b/')).toBe('/a/b');
    expect(normalizeCwd('/a/b///')).toBe('/a/b');
  });

  it('strips trailing backslashes (windows)', () => {
    expect(normalizeCwd('C:\\proj\\')).toBe('C:\\proj');
  });

  it('keeps filesystem roots intact', () => {
    expect(normalizeCwd('/')).toBe('/');
    expect(normalizeCwd('C:\\')).toBe('C:\\');
  });

  it('preserves case', () => {
    expect(normalizeCwd('/Foo/Bar')).toBe('/Foo/Bar');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCwd('  /a/b  ')).toBe('/a/b');
  });
});

describe('resolveWorkflowCwd', () => {
  it('resolves relative workflow cwd against fallback cwd', () => {
    expect(resolveWorkflowCwd('./web', '/repo')).toBe('/repo/web');
    expect(resolveWorkflowCwd('../api', '/repo/packages/app')).toBe('/repo/packages/api');
  });

  it('keeps absolute workflow cwd as-is after normalization', () => {
    expect(resolveWorkflowCwd('/other/app/', '/repo')).toBe('/other/app');
  });
});

describe('normalizeCommand', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeCommand('  npm test  ')).toBe('npm test');
  });

  it('preserves internal whitespace', () => {
    expect(normalizeCommand('  npm   test  ')).toBe('npm   test');
  });
});

describe('classifyApplyEntries', () => {
  const fallbackCwd = '/proj';

  it('marks workflows with no overlap as new', () => {
    const result = classifyApplyEntries(
      [wf('a', 'echo a'), wf('b', 'echo b')],
      [],
      fallbackCwd,
    );
    expect(result.map((r) => r.state)).toEqual(['new', 'new']);
  });

  it('marks duplicates against existing cards by (cwd, command)', () => {
    const cards: ExistingCardForDedup[] = [
      { id: 'card1', cwd: '/proj', command: 'echo a' },
    ];
    const result = classifyApplyEntries([wf('a', 'echo a')], cards, fallbackCwd);
    expect(result[0].state).toBe('duplicate');
    expect(result[0].duplicateOf).toBe('card1');
  });

  it('matches duplicates with trailing-slash differences', () => {
    const cards: ExistingCardForDedup[] = [
      { id: 'card1', cwd: '/proj/', command: 'npm run dev' },
    ];
    const result = classifyApplyEntries(
      [wf('dev', 'npm run dev', { cwd: '/proj' })],
      cards,
      fallbackCwd,
    );
    expect(result[0].state).toBe('duplicate');
  });

  it('does NOT match duplicates with different cwd casing', () => {
    const cards: ExistingCardForDedup[] = [
      { id: 'card1', cwd: '/Proj', command: 'echo a' },
    ];
    const result = classifyApplyEntries(
      [wf('a', 'echo a', { cwd: '/proj' })],
      cards,
      fallbackCwd,
    );
    expect(result[0].state).toBe('new');
  });

  it('matches when command has surrounding whitespace', () => {
    const cards: ExistingCardForDedup[] = [
      { id: 'card1', cwd: '/proj', command: '  echo a  ' },
    ];
    const result = classifyApplyEntries([wf('a', 'echo a')], cards, fallbackCwd);
    expect(result[0].state).toBe('duplicate');
  });

  it('uses workflow.cwd over fallback when present', () => {
    const cards: ExistingCardForDedup[] = [
      { id: 'card1', cwd: '/other', command: 'echo a' },
    ];
    const result = classifyApplyEntries(
      [wf('a', 'echo a', { cwd: '/other' })],
      cards,
      fallbackCwd,
    );
    expect(result[0].state).toBe('duplicate');
  });

  it('flags workflows with args missing default_value as missing-args', () => {
    const result = classifyApplyEntries(
      [
        wf('a', 'deploy {{env}}', {
          arguments: [{ name: 'env' }],
        }),
      ],
      [],
      fallbackCwd,
    );
    expect(result[0].state).toBe('missing-args');
    expect(result[0].missingArgs).toEqual(['env']);
  });

  it('treats workflows whose every arg has a default as new', () => {
    const result = classifyApplyEntries(
      [
        wf('a', 'deploy {{env}}', {
          arguments: [{ name: 'env', default_value: 'staging' }],
        }),
      ],
      [],
      fallbackCwd,
    );
    expect(result[0].state).toBe('new');
  });

  it('dedups using interpolated default argument values', () => {
    const cards: ExistingCardForDedup[] = [
      { id: 'card1', cwd: '/proj', command: 'deploy staging' },
    ];
    const result = classifyApplyEntries(
      [
        wf('a', 'deploy {{env}}', {
          arguments: [{ name: 'env', default_value: 'staging' }],
        }),
      ],
      cards,
      fallbackCwd,
    );
    expect(result[0]).toMatchObject({
      state: 'duplicate',
      duplicateOf: 'card1',
      resolvedCommand: 'deploy staging',
    });
  });

  it('dedups relative workflow cwd after resolving it against fallback', () => {
    const cards: ExistingCardForDedup[] = [
      { id: 'card1', cwd: '/proj/web', command: 'npm test' },
    ];
    const result = classifyApplyEntries(
      [wf('test', 'npm test', { cwd: './web' })],
      cards,
      fallbackCwd,
    );
    expect(result[0]).toMatchObject({
      state: 'duplicate',
      duplicateOf: 'card1',
      resolvedCwd: '/proj/web',
    });
  });

  it('partial overlap: one new + one duplicate', () => {
    const cards: ExistingCardForDedup[] = [
      { id: 'card1', cwd: '/proj', command: 'echo a' },
    ];
    const result = classifyApplyEntries(
      [wf('a', 'echo a'), wf('b', 'echo b')],
      cards,
      fallbackCwd,
    );
    expect(result.map((r) => r.state)).toEqual(['duplicate', 'new']);
  });
});
