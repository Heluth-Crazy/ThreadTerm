import { describe, expect, it } from 'vitest';
import { interpolateWorkflow } from './interpolateWorkflow';
import type { Workflow } from './parseWorkflow';

function makeWorkflow(partial: Partial<Workflow> & Pick<Workflow, 'command'>): Workflow {
  return { name: 'test', ...partial };
}

describe('interpolateWorkflow', () => {
  it('returns ready unchanged when there are no placeholders or arguments', () => {
    const r = interpolateWorkflow(makeWorkflow({ command: 'ls -la' }));
    expect(r).toEqual({ kind: 'ready', command: 'ls -la' });
  });

  it('substitutes when all args have defaults', () => {
    const r = interpolateWorkflow(
      makeWorkflow({
        command: 'git checkout {{branch}}',
        arguments: [{ name: 'branch', default_value: 'main' }],
      }),
    );
    expect(r).toEqual({ kind: 'ready', command: 'git checkout main' });
  });

  it('reports missing args when no default and no override', () => {
    const r = interpolateWorkflow(
      makeWorkflow({
        command: 'git checkout {{branch}}',
        arguments: [{ name: 'branch' }],
      }),
    );
    expect(r.kind).toBe('missing');
    if (r.kind === 'missing') {
      expect(r.missingArgs).toEqual(['branch']);
    }
  });

  it('uses overrides over defaults', () => {
    const r = interpolateWorkflow(
      makeWorkflow({
        command: 'git checkout {{branch}}',
        arguments: [{ name: 'branch', default_value: 'main' }],
      }),
      { branch: 'feature/x' },
    );
    expect(r).toEqual({ kind: 'ready', command: 'git checkout feature/x' });
  });

  it('substitutes every occurrence of the same placeholder', () => {
    const r = interpolateWorkflow(
      makeWorkflow({
        command: 'echo {{branch}} && git push origin {{branch}}',
        arguments: [{ name: 'branch', default_value: 'dev' }],
      }),
    );
    expect(r).toEqual({
      kind: 'ready',
      command: 'echo dev && git push origin dev',
    });
  });

  it('leaves literal `{{` with non-identifier chars intact', () => {
    const r = interpolateWorkflow(
      makeWorkflow({ command: 'echo {{ 1+1 }} and {{-bad}}' }),
    );
    expect(r).toEqual({
      kind: 'ready',
      command: 'echo {{ 1+1 }} and {{-bad}}',
    });
  });

  it('substitutes when there is whitespace inside the braces', () => {
    const r = interpolateWorkflow(
      makeWorkflow({
        command: 'git checkout {{ branch }}',
        arguments: [{ name: 'branch', default_value: 'main' }],
      }),
    );
    expect(r).toEqual({ kind: 'ready', command: 'git checkout main' });
  });

  it('dedupes multiple occurrences of the same missing arg', () => {
    const r = interpolateWorkflow(
      makeWorkflow({ command: '{{x}} and {{x}} and {{y}}' }),
    );
    expect(r.kind).toBe('missing');
    if (r.kind === 'missing') {
      expect(r.missingArgs.sort()).toEqual(['x', 'y']);
    }
  });
});
