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

  it('preserves every custom command byte around its arguments', () => {
    const result = buildTerminalLaunchCommand(
      card({
        terminalType: 'custom',
        command: '  tool --name="two words" --flag  ',
      }),
    );
    expect(result).toEqual({ command: '  tool --name="two words" --flag  ' });
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

  it('preserves an explicitly configured Codex command', () => {
    const result = buildTerminalLaunchCommand(
      card({ terminalType: 'codex', command: 'codex -c tui.animations=false' }),
      'codex',
    );
    expect(result).toEqual({ command: 'codex -c tui.animations=false' });
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

  it('starts OpenCode/Gemini/Kimi with discovery and resumes bound sessions', () => {
    expect(buildTerminalLaunchCommand(card({ terminalType: 'opencode' }), 'opencode')).toEqual({
      command: 'opencode',
      provider: 'opencode',
      action: 'discover',
    });
    expect(buildTerminalLaunchCommand(card({ terminalType: 'gemini' }), 'gemini')).toEqual({
      command: 'gemini',
      provider: 'gemini',
      action: 'discover',
    });
    expect(buildTerminalLaunchCommand(card({ terminalType: 'kimi' }), 'kimi')).toEqual({
      command: 'kimi',
      provider: 'kimi',
      action: 'discover',
    });
    expect(
      buildTerminalLaunchCommand(
        card({
          terminalType: 'opencode',
          providerSessionId: 'oc-1',
          providerSessionState: 'bound',
        }),
        'opencode',
      ),
    ).toEqual({
      command: 'opencode --session oc-1',
      provider: 'opencode',
      providerSessionId: 'oc-1',
      action: 'resume',
    });
    expect(
      buildTerminalLaunchCommand(
        card({
          terminalType: 'gemini',
          providerSessionId: 'gem-1',
          providerSessionState: 'bound',
        }),
        'gemini',
      ),
    ).toEqual({
      command: 'gemini --resume gem-1',
      provider: 'gemini',
      providerSessionId: 'gem-1',
      action: 'resume',
    });
    expect(
      buildTerminalLaunchCommand(
        card({
          terminalType: 'kimi',
          providerSessionId: 'kimi-1',
          providerSessionState: 'bound',
        }),
        'kimi',
      ),
    ).toEqual({
      command: 'kimi --session kimi-1',
      provider: 'kimi',
      providerSessionId: 'kimi-1',
      action: 'resume',
    });
  });

  it('starts Grok with a caller-supplied session id and resumes bound sessions', () => {
    expect(
      buildTerminalLaunchCommand(
        card({
          terminalType: 'grok',
          providerSessionId: '11111111-1111-4111-8111-111111111111',
          providerSessionState: 'unbound',
        }),
        'grok',
      ),
    ).toEqual({
      command: 'grok --session-id 11111111-1111-4111-8111-111111111111',
      provider: 'grok',
      providerSessionId: '11111111-1111-4111-8111-111111111111',
      action: 'start',
    });
    expect(
      buildTerminalLaunchCommand(
        card({
          terminalType: 'grok',
          providerSessionId: '11111111-1111-4111-8111-111111111111',
          providerSessionState: 'bound',
        }),
        'grok',
      ),
    ).toEqual({
      command: 'grok --resume 11111111-1111-4111-8111-111111111111',
      provider: 'grok',
      providerSessionId: '11111111-1111-4111-8111-111111111111',
      action: 'resume',
    });
  });

  it('preserves custom commands byte-for-byte for Kimi/Grok cards', () => {
    expect(
      buildTerminalLaunchCommand(
        card({ terminalType: 'kimi', command: 'kimi --model moonshot' }),
        'kimi',
      ),
    ).toEqual({ command: 'kimi --model moonshot' });
    expect(
      buildTerminalLaunchCommand(
        card({ terminalType: 'grok', command: 'grok --resume keep-me' }),
        'grok',
      ),
    ).toEqual({ command: 'grok --resume keep-me' });
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

  it('describes unbound Gemini/OpenCode/Kimi as discovery sessions', () => {
    expect(getAiCliSessionBadge(card({ terminalType: 'gemini' }))?.labelKey).toBe(
      'aiSession.discovery',
    );
    expect(getAiCliSessionBadge(card({ terminalType: 'opencode' }))?.labelKey).toBe(
      'aiSession.discovery',
    );
    expect(getAiCliSessionBadge(card({ terminalType: 'kimi' }))?.labelKey).toBe(
      'aiSession.discovery',
    );
  });

  it('describes bound OpenCode and Kimi as resume-ready', () => {
    expect(
      getAiCliSessionBadge(
        card({
          terminalType: 'opencode',
          providerSessionId: 'oc-bound-1',
          providerSessionState: 'bound',
        }),
      )?.labelKey,
    ).toBe('aiSession.resumeReady');
    expect(
      getAiCliSessionBadge(
        card({
          terminalType: 'kimi',
          providerSessionId: 'kimi-bound-1',
          providerSessionState: 'bound',
        }),
      )?.labelKey,
    ).toBe('aiSession.resumeReady');
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
