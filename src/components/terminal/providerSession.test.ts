import { describe, expect, it } from 'vitest';
import type { TerminalCard } from '../../types/terminal';
import { buildTerminalLaunchCommand, shellQuote } from './providerSession';

function card(overrides: Partial<TerminalCard>): TerminalCard {
  return {
    id: 'card-1',
    ptyId: 'card-1',
    projectPath: '/project',
    projectName: 'project',
    terminalType: 'shell',
    status: 'idle',
    createdAt: 1,
    lastActivity: 1,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    ...overrides,
  };
}

describe('providerSession launch command builder', () => {
  it('quotes shell args safely', () => {
    expect(shellQuote('abc-123_./')).toBe('abc-123_./');
    expect(shellQuote("a b'c")).toBe("'a b'\\''c'");
  });

  it('uses custom card command before provider defaults', () => {
    const result = buildTerminalLaunchCommand(
      card({ terminalType: 'claude', command: 'claude --resume manual' }),
      'claude',
    );
    expect(result).toEqual({ command: 'claude --resume manual' });
  });

  it('starts a new Claude session with a generated session id', () => {
    const result = buildTerminalLaunchCommand(
      card({
        terminalType: 'claude',
        providerSessionId: '11111111-1111-4111-8111-111111111111',
        providerSessionState: 'unbound',
      }),
      'claude',
    );
    expect(result).toEqual({
      command: 'claude --session-id 11111111-1111-4111-8111-111111111111',
      provider: 'claude',
      providerSessionId: '11111111-1111-4111-8111-111111111111',
      action: 'start',
    });
  });

  it('resumes a bound Claude session', () => {
    const result = buildTerminalLaunchCommand(
      card({
        terminalType: 'claude',
        providerSessionId: '11111111-1111-4111-8111-111111111111',
        providerSessionState: 'bound',
      }),
      'claude',
    );
    expect(result.command).toBe('claude --resume 11111111-1111-4111-8111-111111111111');
    expect(result.action).toBe('resume');
  });

  it('starts Codex with inline scrollback when no native id is bound', () => {
    const result = buildTerminalLaunchCommand(card({ terminalType: 'codex' }), 'codex');
    expect(result).toEqual({
      command: 'codex --no-alt-screen',
      provider: 'codex',
      action: 'discover',
    });
  });

  it('resumes a bound Codex session', () => {
    const result = buildTerminalLaunchCommand(
      card({
        terminalType: 'codex',
        providerSessionId: '019dc22d-aa3f-7982-a872-4a862cb8588f',
        providerSessionState: 'bound',
      }),
      'codex',
    );
    expect(result).toEqual({
      command: 'codex resume 019dc22d-aa3f-7982-a872-4a862cb8588f --no-alt-screen',
      provider: 'codex',
      providerSessionId: '019dc22d-aa3f-7982-a872-4a862cb8588f',
      action: 'resume',
    });
  });

  it('falls back to non-provider default commands', () => {
    expect(buildTerminalLaunchCommand(card({ terminalType: 'python' }), 'python3')).toEqual({
      command: 'python3',
    });
    expect(buildTerminalLaunchCommand(card({ terminalType: 'shell' }), '')).toEqual({});
  });
});

