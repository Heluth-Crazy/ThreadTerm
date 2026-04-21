import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { respondToApprovalRequestMock, acknowledgeAttentionItemMock } = vi.hoisted(() => ({
  respondToApprovalRequestMock: vi.fn(),
  acknowledgeAttentionItemMock: vi.fn(),
}));

vi.mock('../../lib/approval-actions', () => ({
  respondToApprovalRequest: respondToApprovalRequestMock,
}));

vi.mock('../../lib/attention-actions', () => ({
  acknowledgeAttentionItem: acknowledgeAttentionItemMock,
}));

import ApprovalInbox from './ApprovalInbox';
import AttentionInbox from './AttentionInbox';

describe('Mission Control inbox affordances', () => {
  it('shows session context and review-next affordance for approvals', () => {
    const onOpenSession = vi.fn();

    render(
      <ApprovalInbox
        requests={[
          {
            id: 'approval-item-1',
            requestId: 'req-1',
            toolName: 'Bash',
            input: { command: 'npm run typecheck' },
            riskLevel: 'high',
            sessionId: 'session-1',
            status: 'pending',
            createdAt: 1,
            updatedAt: 2,
          },
        ]}
        onOpenSession={onOpenSession}
        sessionLabels={{
          'session-1': {
            title: 'Fix flaky tests',
            subtitle: 'OpenWork · Claude',
          },
        }}
      />,
    );

    expect(screen.getByText('Fix flaky tests')).toBeInTheDocument();
    expect(screen.getByText('OpenWork · Claude')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review next' }));
    expect(onOpenSession).toHaveBeenCalledWith('session-1');
  });

  it('shows session context and review-next affordance for attention items', () => {
    const onOpenSession = vi.fn();

    render(
      <AttentionInbox
        items={[
          {
            id: 'attention-1',
            sessionId: 'session-2',
            kind: 'error',
            status: 'active',
            reason: 'error',
            title: 'Session requires attention',
            message: 'Build failed',
            riskLevel: 'high',
            createdAt: 1,
            updatedAt: 10,
          },
        ]}
        onOpenSession={onOpenSession}
        sessionLabels={{
          'session-2': {
            title: 'Release prep',
            subtitle: 'Desktop App · Codex',
          },
        }}
      />,
    );

    expect(screen.getByText('Release prep')).toBeInTheDocument();
    expect(screen.getByText('Desktop App · Codex')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review next' }));
    expect(onOpenSession).toHaveBeenCalledWith('session-2');
  });
});
