import { describe, expect, it } from 'vitest';
import type {
  PtyCreateSessionV2Request,
  PtyCreateSessionV2Result,
  PtyStartupSnapshot,
} from '../../types/ptyStartup';
import { buildProviderStartupIntent } from './providerStartup';
import type { TerminalLaunchCommand } from './providerSession';

const providers = ['claude', 'codex', 'opencode', 'gemini', 'kimi', 'grok'] as const;

describe('buildProviderStartupIntent', () => {
  it.each(providers)('builds discover intent for %s', (provider) => {
    expect(buildProviderStartupIntent('card-1', {
      provider,
      command: `${provider} --new`,
      action: 'discover',
    })).toEqual({
      kind: 'provider',
      provider,
      command: `${provider} --new`,
      cardId: 'card-1',
      action: 'discover',
      sideEffectPlan: { kind: 'discover' },
    });
  });

  it.each(providers)('binds an existing %s session without changing its id', (provider) => {
    const providerSessionId = `${provider}-session`;
    expect(buildProviderStartupIntent('card-1', {
      provider,
      command: `${provider} --resume ${providerSessionId}`,
      providerSessionId,
      action: 'resume',
    })?.sideEffectPlan).toEqual({ kind: 'bind', providerSessionId });
  });

  it.each(['claude', 'grok'] as const)('binds preallocated %s start sessions', (provider) => {
    const providerSessionId = `${provider}-preallocated`;
    expect(buildProviderStartupIntent('card-1', {
      provider,
      command: `${provider} --session-id ${providerSessionId}`,
      providerSessionId,
      action: 'start',
    })?.sideEffectPlan).toEqual({ kind: 'bind', providerSessionId });
  });

  it('preserves raw whitespace in every identity field', () => {
    const result = buildProviderStartupIntent('  card-1  ', {
      provider: 'claude',
      command: '  claude --resume session-1  ',
      providerSessionId: '  session-1  ',
      action: 'resume',
    });
    expect(result).toEqual({
      kind: 'provider',
      provider: 'claude',
      command: '  claude --resume session-1  ',
      cardId: '  card-1  ',
      action: 'resume',
      sideEffectPlan: { kind: 'bind', providerSessionId: '  session-1  ' },
    });
  });

  it.each([
    ['custom', 'card-1', { command: 'echo custom' }],
    ['plain', 'card-1', { command: 'pwsh' }],
    ['missing command', 'card-1', { provider: 'claude', action: 'start' }],
    ['missing action', 'card-1', { provider: 'claude', command: 'claude' }],
    ['missing provider', 'card-1', { command: 'claude', action: 'start' }],
    ['missing card', '', { provider: 'claude', command: 'claude', action: 'start' }],
  ])('returns null for %s launches', (_label, cardId, launch) => {
    expect(buildProviderStartupIntent(cardId, launch as TerminalLaunchCommand)).toBeNull();
  });

  it('uses only camelCase contract keys and no sensitive debug extras', () => {
    const result = buildProviderStartupIntent('card-1', {
      provider: 'grok',
      command: 'grok',
      action: 'discover',
    });
    expect(JSON.stringify(result)).toBe(JSON.stringify({
      kind: 'provider',
      provider: 'grok',
      command: 'grok',
      cardId: 'card-1',
      action: 'discover',
      sideEffectPlan: { kind: 'discover' },
    }));
    expect(JSON.stringify(result)).not.toContain('providerSessionId');
    expect(result).not.toHaveProperty('fingerprint');
    expect(result).not.toHaveProperty('debug');
    expect(result).not.toHaveProperty('log');
  });

  it('serializes the v2 request/result contract with no snake_case extras', () => {
    const snapshot: PtyStartupSnapshot = {
      ptyId: 'pty-1',
      generation: 'generation-1',
      revision: 2,
      state: 'sent',
      trigger: 'immediate',
    };
    const request: PtyCreateSessionV2Request = {
      id: 'pty-1',
      workingDir: 'C:/project',
      rows: 24,
      cols: 80,
      launchAttemptId: 'attempt-1',
      startup: { kind: 'oneShot', descriptor: { executionMode: 'oneShot', command: 'echo ok' } },
    };
    const result: PtyCreateSessionV2Result = {
      ptyId: 'pty-1',
      generation: 'generation-1',
      disposition: 'created',
      shellFamily: 'posix',
      descriptorDisposition: 'accepted',
      startup: snapshot,
    };
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/descriptor_disposition|fingerprint|debug|log/);
  });
});
