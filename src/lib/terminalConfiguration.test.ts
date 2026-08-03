import { describe, expect, it } from 'vitest';
import {
  findTerminalSessionBindingConflict,
  isSafeProviderSessionId,
  normalizeTerminalLaunchConfiguration,
  parsePersistedTerminalLaunchConfiguration,
  terminalLaunchConfigurationFromCard,
  terminalLaunchConfigurationsEqual,
} from './terminalConfiguration';

describe('terminalConfiguration', () => {
  it('normalizes mutually exclusive default, custom, and resume modes', () => {
    expect(
      normalizeTerminalLaunchConfiguration({
        terminalType: 'codex',
        launchMode: 'default',
        command: 'ignored',
        providerSessionId: 'ignored',
      }),
    ).toEqual({
      ok: true,
      value: { terminalType: 'codex', launchMode: 'default' },
    });

    expect(
      normalizeTerminalLaunchConfiguration({
        terminalType: 'shell',
        launchMode: 'custom',
        command: '  npm run dev  ',
        providerSessionId: 'ignored',
      }),
    ).toEqual({
      ok: true,
      value: {
        terminalType: 'shell',
        launchMode: 'custom',
        command: '  npm run dev  ',
      },
    });

    expect(
      normalizeTerminalLaunchConfiguration({
        terminalType: 'claude',
        launchMode: 'resume',
        providerSessionId: '  session-1  ',
        workspaceMode: 'session',
        sessionProjectPath: '  /repo/app  ',
        command: 'ignored',
      }),
    ).toEqual({
      ok: true,
      value: {
        terminalType: 'claude',
        launchMode: 'resume',
        providerSessionId: 'session-1',
        workspaceMode: 'session',
        sessionProjectPath: '/repo/app',
      },
    });
  });

  it('rejects invalid commands, providers, ids, and session workspaces', () => {
    expect(
      normalizeTerminalLaunchConfiguration({
        terminalType: 'shell',
        launchMode: 'custom',
        command: ' ',
      }),
    ).toEqual({ ok: false, error: 'command-required' });
    expect(
      normalizeTerminalLaunchConfiguration({
        terminalType: 'shell',
        launchMode: 'resume',
        providerSessionId: 'session-1',
      }),
    ).toEqual({ ok: false, error: 'agent-required' });
    expect(
      normalizeTerminalLaunchConfiguration({
        terminalType: 'codex',
        launchMode: 'resume',
        providerSessionId: 'bad id',
      }),
    ).toEqual({ ok: false, error: 'session-id-invalid' });
    expect(
      normalizeTerminalLaunchConfiguration({
        terminalType: 'gemini',
        launchMode: 'resume',
        providerSessionId: 'session-1',
        workspaceMode: 'session',
      }),
    ).toEqual({ ok: false, error: 'session-project-required' });
  });

  it('matches the backend-safe manual session id contract', () => {
    expect(isSafeProviderSessionId('019f-abcd_1.2:root')).toBe(true);
    expect(isSafeProviderSessionId('contains space')).toBe(false);
    expect(isSafeProviderSessionId('a'.repeat(257))).toBe(false);
  });

  it('derives the active launch mode without retaining hidden fields', () => {
    expect(
      terminalLaunchConfigurationFromCard({
        terminalType: 'codex',
        command: 'codex --help',
        providerSessionId: 'hidden',
        providerSessionState: 'bound',
      }),
    ).toEqual({
      terminalType: 'codex',
      launchMode: 'custom',
      command: 'codex --help',
    });
    expect(
      terminalLaunchConfigurationFromCard({
        terminalType: 'opencode',
        providerSessionId: 'oc-1',
        providerSessionState: 'bound',
      }),
    ).toEqual({
      terminalType: 'opencode',
      launchMode: 'resume',
      providerSessionId: 'oc-1',
      workspaceMode: 'current',
    });
    expect(
      terminalLaunchConfigurationFromCard({
        terminalType: 'shell',
        command: '  npm run dev -- --flag="two words"  ',
        providerSessionId: undefined,
        providerSessionState: undefined,
      }),
    ).toEqual({
      terminalType: 'shell',
      launchMode: 'custom',
      command: '  npm run dev -- --flag="two words"  ',
    });
  });

  it('compares normalized configurations and rejects invalid persisted data', () => {
    const left = {
      terminalType: 'codex' as const,
      launchMode: 'resume' as const,
      providerSessionId: 'root-1',
      workspaceMode: 'current' as const,
    };
    expect(terminalLaunchConfigurationsEqual(left, { ...left })).toBe(true);
    expect(
      terminalLaunchConfigurationsEqual(left, {
        ...left,
        providerSessionId: 'root-2',
      }),
    ).toBe(false);
    expect(
      terminalLaunchConfigurationsEqual(left, {
        ...left,
        sessionProjectPath: '/catalog/source/is-only-informational',
      }),
    ).toBe(true);
    expect(
      terminalLaunchConfigurationsEqual(
        {
          ...left,
          workspaceMode: 'session',
          sessionProjectPath: '/repo/one',
        },
        {
          ...left,
          workspaceMode: 'session',
          sessionProjectPath: '/repo/two',
        },
      ),
    ).toBe(false);
    expect(parsePersistedTerminalLaunchConfiguration(left)).toEqual(left);
    expect(
      parsePersistedTerminalLaunchConfiguration({
        terminalType: 'other',
        launchMode: 'default',
      }),
    ).toBeNull();
  });

  it('finds active and archived provider-session conflicts while excluding the edited card', () => {
    const cards = [
      {
        id: 'active',
        terminalType: 'codex' as const,
        providerSessionId: 'session-1',
      },
      {
        id: 'edited',
        terminalType: 'codex' as const,
        providerSessionId: 'session-2',
      },
    ];
    const archivedCards = [
      {
        id: 'archived',
        terminalType: 'claude' as const,
        providerSessionId: 'session-3',
        archivedAt: 10,
      },
    ];

    expect(
      findTerminalSessionBindingConflict(
        cards,
        archivedCards,
        'codex',
        'session-1',
        'edited',
      ),
    ).toEqual({ cardId: 'active', archived: false });
    expect(
      findTerminalSessionBindingConflict(
        cards,
        archivedCards,
        'claude',
        'session-3',
        'edited',
      ),
    ).toEqual({ cardId: 'archived', archived: true });
    expect(
      findTerminalSessionBindingConflict(
        cards,
        archivedCards,
        'codex',
        'session-2',
        'edited',
      ),
    ).toBeNull();
  });
});
