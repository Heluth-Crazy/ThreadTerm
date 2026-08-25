import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalCard } from '../../types/terminal';
import { FloatSession } from './FloatSession';

const launchMock = vi.hoisted(() => ({
  action: 'resume',
}));

vi.mock('react-i18next', () => ({
  Trans: () => null,
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../components/terminal/Shell', () => ({
  default: ({ resumeLoading, providerStartup }: {
    resumeLoading?: boolean;
    providerStartup?: { kind: string; command: string };
  }) => (
    <div
      data-testid="float-shell"
      data-resume-loading={String(Boolean(resumeLoading))}
      data-provider-startup={providerStartup?.kind ?? 'none'}
    />
  ),
}));

vi.mock('../../components/terminal/useValidatedProviderSessionLaunch', () => ({
  useValidatedProviderSessionLaunch: (card: TerminalCard) => ({
    lifecycleCard: card,
    launch: {
      command: 'agent resume session-a',
      provider: 'gemini',
      action: launchMock.action,
    },
    status: 'ready',
    retry: vi.fn(),
  }),
}));

vi.mock('../../stores/terminalStore', () => ({
  useTerminalStore: (
    selector: (state: {
      markCardRead: ReturnType<typeof vi.fn>;
      recordUserSubmit: ReturnType<typeof vi.fn>;
    }) => unknown,
  ) =>
    selector({
      markCardRead: vi.fn(),
      recordUserSubmit: vi.fn(),
    }),
}));

const CARD: TerminalCard = {
  id: 'float-agent',
  ptyId: 'float-agent',
  projectPath: '/repo/threadterm',
  projectName: 'ThreadTerm',
  terminalType: 'gemini',
  providerSessionId: 'session-a',
  providerSessionState: 'bound',
  status: 'idle',
  createdAt: 1_700_000_000_000,
  lastActivity: 1_700_000_060_000,
  lastOutput: '',
  lastReplyPreview: '',
  messageCount: 0,
  events: [],
  unread: false,
};

describe('FloatSession history progress forwarding', () => {
  beforeEach(() => {
    launchMock.action = 'resume';
  });

  afterEach(() => {
    cleanup();
  });

  it('uses the same resume progress signal as the main terminal', () => {
    render(<FloatSession card={CARD} />);

    expect(screen.getByTestId('float-shell')).toHaveAttribute(
      'data-resume-loading',
      'true',
    );
  });

  it('does not show history progress for a normal Agent launch', () => {
    launchMock.action = 'start';
    render(<FloatSession card={CARD} />);

    expect(screen.getByTestId('float-shell')).toHaveAttribute(
      'data-resume-loading',
      'false',
    );
  });

  it('passes the validated Provider descriptor to Shell', () => {
    render(<FloatSession card={CARD} />);

    expect(screen.getByTestId('float-shell')).toHaveAttribute(
      'data-provider-startup',
      'provider',
    );
  });
});
