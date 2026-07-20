import { describe, expect, it } from 'vitest';
import { deriveAgentSessionTitle } from './agentSessionTitle';
import type { AgentSessionSummary } from '../types/agentSession';

function summary(
  overrides: Partial<AgentSessionSummary> & Pick<AgentSessionSummary, 'provider' | 'id'>,
): AgentSessionSummary {
  return {
    projectPath: '/repo',
    titleKind: 'unknown',
    resumable: true,
    ...overrides,
  };
}

describe('deriveAgentSessionTitle', () => {
  it('prefers explicit rename over first prompt', () => {
    const result = deriveAgentSessionTitle(
      summary({
        provider: 'claude',
        id: 'abc',
        titleKind: 'explicit',
        nativeTitle: 'Login rewrite',
        firstUserMessagePreview: 'please fix auth',
      }),
    );
    expect(result).toEqual({
      primary: 'Login rewrite',
      secondary: 'please fix auth',
      kind: 'explicit',
    });
  });

  it('falls back to first prompt then provider id', () => {
    expect(
      deriveAgentSessionTitle(
        summary({
          provider: 'codex',
          id: '0123456789',
          titleKind: 'firstPrompt',
          firstUserMessagePreview: 'Ship the patch',
        }),
      ).primary,
    ).toBe('Ship the patch');

    expect(
      deriveAgentSessionTitle(
        summary({
          provider: 'codex',
          id: '0123456789',
          titleKind: 'unknown',
        }),
      ).primary,
    ).toBe('Codex · …56789');
  });

  it('keeps OpenCode titles as unknown provenance', () => {
    const result = deriveAgentSessionTitle(
      summary({
        provider: 'opencode',
        id: 'oc-1',
        titleKind: 'unknown',
        nativeTitle: 'Build UI',
        firstUserMessagePreview: 'create dense list',
      }),
    );
    expect(result.kind).toBe('unknown');
    expect(result.primary).toBe('Build UI');
    expect(result.secondary).toBe('create dense list');
  });

  it('ignores generic native titles when a prompt exists', () => {
    const result = deriveAgentSessionTitle(
      summary({
        provider: 'claude',
        id: 'x',
        titleKind: 'generated',
        nativeTitle: 'New session',
        firstUserMessagePreview: 'Real work',
      }),
    );
    expect(result.primary).toBe('Real work');
    expect(result.kind).toBe('firstPrompt');
  });
});
