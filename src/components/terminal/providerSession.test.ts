import { describe, expect, it } from 'vitest';
import type { TerminalCard } from '../../types/terminal';
import {
  buildTerminalLaunchCommand,
  getAiCliSessionBadge,
  getMissingAiCliName,
  shellQuote,
} from './providerSession';

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
    expect(buildTerminalLaunchCommand(card({ terminalType: 'opencode' }), 'opencode')).toEqual({
      command: 'opencode',
    });
    expect(buildTerminalLaunchCommand(card({ terminalType: 'shell' }), '')).toEqual({});
  });
});

describe('providerSession AI CLI state badge', () => {
  it('does not render a badge for non-AI terminal types', () => {
    expect(getAiCliSessionBadge(card({ terminalType: 'shell' }))).toBeNull();
  });

  it('describes a new Claude session id before it is bound', () => {
    const result = getAiCliSessionBadge(
      card({
        terminalType: 'claude',
        providerSessionId: '11111111-1111-4111-8111-111111111111',
        providerSessionState: 'unbound',
      }),
    );
    expect(result?.labelKey).toBe('aiSession.newSession');
    expect(result?.tone).toBe('info');
  });

  it('describes a bound Codex session as resume-ready', () => {
    const result = getAiCliSessionBadge(
      card({
        terminalType: 'codex',
        providerSessionId: '019dc22d-aa3f-7982-a872-4a862cb8588f',
        providerSessionState: 'bound',
      }),
    );
    expect(result?.labelKey).toBe('aiSession.resumeReady');
    expect(result?.tone).toBe('success');
    expect(result?.values?.id).toBe('...8588f');
  });

  it('describes Gemini as CLI-only until native resume support exists', () => {
    const result = getAiCliSessionBadge(card({ terminalType: 'gemini' }));
    expect(result?.labelKey).toBe('aiSession.cliOnly');
    expect(result?.values?.cli).toBe('Gemini');
  });

  it('describes OpenCode as CLI-only until native resume support exists', () => {
    const result = getAiCliSessionBadge(card({ terminalType: 'opencode' }));
    expect(result?.labelKey).toBe('aiSession.cliOnly');
    expect(result?.values?.cli).toBe('OpenCode');
  });

  it('detects missing AI CLI output', () => {
    const missing = card({
      terminalType: 'codex',
      lastOutput: 'zsh: command not found: codex\n',
    });
    expect(getMissingAiCliName(missing)).toBe('Codex');

    const result = getAiCliSessionBadge(missing);
    expect(result?.labelKey).toBe('aiSession.missingCli');
    expect(result?.tone).toBe('danger');

    const missingOpenCode = card({
      terminalType: 'opencode',
      lastOutput: 'opencode: command not found\n',
    });
    expect(getMissingAiCliName(missingOpenCode)).toBe('OpenCode');
  });
});
