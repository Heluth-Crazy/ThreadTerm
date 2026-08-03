import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { TerminalCard } from '../types/terminal';
import type { AgentSessionSummary } from '../types/agentSession';
import { buildWorkspaceTerminalPresentation } from './workspaceTerminalPresentation';

const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as TFunction;

function card(overrides: Partial<TerminalCard> = {}): TerminalCard {
  return {
    id: 'c1',
    ptyId: 'c1',
    projectPath: '/repo',
    projectName: 'Same Name',
    terminalType: 'kimi',
    status: 'running',
    createdAt: 1,
    lastActivity: 1,
    lastOutput: 'SECRET OUTPUT',
    lastReplyPreview: 'secret reply',
    messageCount: 0,
    events: [],
    unread: false,
    providerSessionId: 'sess-123456789',
    providerSessionState: 'bound',
    ...overrides,
  };
}

describe('workspace terminal presentation', () => {
  it('prefers native title and keeps ThreadTerm name secondary', () => {
    const metadata: AgentSessionSummary = {
      provider: 'kimi',
      id: 'sess-123456789',
      projectPath: '/repo',
      nativeTitle: 'Fix auth race',
      titleKind: 'explicit',
      resumable: true,
    };
    const presentation = buildWorkspaceTerminalPresentation(card(), {
      t,
      metadata,
      now: 60_000,
    });
    expect(presentation.primaryTitle).toBe('Fix auth race');
    expect(presentation.secondaryTitle).toBe('Same Name');
    expect(presentation.tooltip).not.toContain('SECRET');
    expect(presentation.tooltip).not.toContain('sess-123456789');
    expect(presentation.tooltip).toContain('…56789');
  });

  it('falls back to ThreadTerm name for shell and unbound agents', () => {
    const shell = buildWorkspaceTerminalPresentation(
      card({ terminalType: 'shell', providerSessionId: undefined, providerSessionState: undefined }),
      { t, metadata: null },
    );
    expect(shell.primaryTitle).toBe('Same Name');
    expect(shell.secondaryTitle).toBeUndefined();

    const unbound = buildWorkspaceTerminalPresentation(
      card({ providerSessionState: 'unbound' }),
      {
        t,
        metadata: {
          provider: 'kimi',
          id: 'sess-123456789',
          projectPath: '/repo',
          nativeTitle: 'Should not show',
          titleKind: 'explicit',
          resumable: true,
        },
      },
    );
    expect(unbound.primaryTitle).toBe('Same Name');
  });

  it('never includes command text in presentation', () => {
    const presentation = buildWorkspaceTerminalPresentation(
      card({ command: 'kimi --session secret-command' }),
      { t, metadata: null },
    );
    expect(JSON.stringify(presentation)).not.toContain('secret-command');
  });
});
