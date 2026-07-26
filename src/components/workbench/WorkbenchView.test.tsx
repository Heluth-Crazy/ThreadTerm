import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  AttentionItem,
  ExecutionContextGroup,
  WorkbenchSummary,
} from '../../lib/workbench/types';
import type { TerminalCard } from '../../types/terminal';
import { WorkbenchView } from './WorkbenchView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: Record<string, string | number | undefined> & { defaultValue?: string },
    ) => {
      let value = options?.defaultValue ?? key;
      for (const [name, replacement] of Object.entries(options ?? {})) {
        value = value.split(`{{${name}}}`).join(String(replacement));
      }
      return value;
    },
    i18n: { language: 'en' },
  }),
}));

const NOW = 1_000_000;

function makeCard(overrides: Partial<TerminalCard> = {}): TerminalCard {
  return {
    id: 'card-1',
    ptyId: 'card-1',
    projectPath: '/repo',
    projectName: 'Repo',
    terminalType: 'codex',
    status: 'waiting',
    createdAt: NOW - 10_000,
    lastActivity: NOW - 5_000,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 1,
    events: [],
    unread: true,
    ...overrides,
  };
}

const approvalItem: AttentionItem = {
  id: 'structured_request:req-1',
  cardId: 'card-1',
  kind: 'approval',
  severity: 'critical',
  sourceKind: 'structured_request',
  sourceId: 'req-1',
  occurredAt: NOW - 3_000,
  projectPath: '/repo',
  projectName: 'Repo',
  terminalType: 'codex',
  title: 'Approval needed',
  detail: 'Run a repository command',
  reasonCode: 'structured_approval',
  capability: {
    openRequest: true,
    openTerminal: true,
    openNotification: true,
    openEvidence: false,
  },
};

const failedItem: AttentionItem = {
  id: 'terminal_state:card-2',
  cardId: 'card-2',
  kind: 'failed',
  severity: 'critical',
  sourceKind: 'terminal_state',
  sourceId: 'card-2',
  occurredAt: NOW - 2_000,
  projectPath: '/other',
  projectName: 'Other',
  terminalType: 'claude',
  title: 'Build failed',
  detail: 'Command exited with code 1',
  reasonCode: 'failed_state',
  capability: {
    openRequest: false,
    openTerminal: true,
    openNotification: false,
    openEvidence: false,
  },
};

const executionGroup: ExecutionContextGroup = {
  id: '/repo\u001f/repo',
  projectPath: '/repo',
  projectName: 'Repo',
  worktreePath: '/repo',
  cardIds: ['card-1', 'card-2'],
  terminalCount: 2,
  terminalTypes: ['codex', 'claude'],
  attentionCount: 2,
  status: 'attention',
  terminalStatuses: ['waiting', 'failed'],
  lastActivity: NOW - 2_000,
  preview: 'latest real output',
};

const runningGroup: ExecutionContextGroup = {
  id: '/running\u001f/running',
  projectPath: '/running',
  projectName: 'Running',
  worktreePath: '/running',
  cardIds: ['card-3'],
  terminalCount: 1,
  terminalTypes: ['codex'],
  attentionCount: 0,
  status: 'running',
  terminalStatuses: ['running'],
  lastActivity: NOW - 1_000,
  preview: 'steady output',
};

const summary: WorkbenchSummary = {
  attention: 2,
  normalRunning: 0,
  review: 0,
  failed: 1,
};

function renderWorkbench(overrides: Partial<Parameters<typeof WorkbenchView>[0]> = {}) {
  const callbacks = {
    onOpenTerminal: vi.fn(),
    onOpenAttention: vi.fn(),
    onOpenGroup: vi.fn(),
    onOpenRules: vi.fn(),
    onNavigateTerminals: vi.fn(),
    onCreateTerminal: vi.fn(),
  };
  const props: Parameters<typeof WorkbenchView>[0] = {
    cards: [
      makeCard(),
      makeCard({
        id: 'card-2',
        ptyId: 'card-2',
        projectPath: '/other',
        projectName: 'Other',
        terminalType: 'claude',
        status: 'failed',
      }),
    ],
    attentionItems: [approvalItem, failedItem],
    groups: [executionGroup],
    summary,
    now: NOW,
    scopeLabel: null,
    ...callbacks,
    ...overrides,
  };
  render(<WorkbenchView {...props} />);
  return { props, callbacks };
}

describe('WorkbenchView', () => {
  it('renders real attention signals with navigation-only actions', () => {
    const { callbacks } = renderWorkbench();

    expect(screen.getByText('Approval needed')).toBeInTheDocument();
    expect(screen.getByText('Build failed')).toBeInTheDocument();
    expect(screen.getByText('latest real output')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'View request' })[0]);
    expect(callbacks.onOpenTerminal).toHaveBeenCalledWith('card-1');

    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);
    expect(callbacks.onOpenAttention).toHaveBeenCalledWith(approvalItem);

    fireEvent.click(screen.getByText('latest real output').closest('button')!);
    expect(callbacks.onOpenGroup).toHaveBeenCalledWith(executionGroup);

    fireEvent.click(screen.getByRole('button', { name: 'Attention rules' }));
    expect(callbacks.onOpenRules).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adjust plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask steward' })).toBeNull();
  });

  it('filters attention items locally and searches both items and groups', () => {
    renderWorkbench();

    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    expect(screen.queryByText('Approval needed')).toBeNull();
    expect(screen.getByText('Build failed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Needs attention: 2' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search workbench' }), {
      target: { value: 'other' },
    });

    expect(screen.queryByText('Approval needed')).toBeNull();
    expect(screen.getByText('Build failed')).toBeInTheDocument();
    expect(screen.queryByText('latest real output')).toBeNull();
  });

  it('keeps summary status changes inside the workbench', () => {
    const { callbacks } = renderWorkbench({
      cards: [
        makeCard(),
        makeCard({
          id: 'card-2',
          ptyId: 'card-2',
          projectPath: '/other',
          projectName: 'Other',
          terminalType: 'claude',
          status: 'failed',
        }),
        makeCard({
          id: 'card-3',
          ptyId: 'card-3',
          projectPath: '/running',
          projectName: 'Running',
          status: 'running',
        }),
      ],
      groups: [executionGroup, runningGroup],
      summary: {
        attention: 2,
        normalRunning: 1,
        review: 0,
        failed: 1,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    expect(screen.getByText('Build failed')).toBeInTheDocument();

    const runningFilter = screen.getByRole('button', {
      name: 'Running normally: 1',
    });
    fireEvent.click(runningFilter);

    expect(runningFilter).toHaveAttribute('aria-pressed', 'true');
    expect(callbacks.onNavigateTerminals).not.toHaveBeenCalled();
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument();
    expect(screen.getByText('steady output')).toBeInTheDocument();
    expect(screen.queryByText('latest real output')).toBeNull();
    expect(screen.queryByText('Approval needed')).toBeNull();
    expect(screen.queryByText('Build failed')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Needs attention: 2' }));
    expect(screen.getByText('Approval needed')).toBeInTheDocument();
    expect(screen.getByText('Build failed')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /^View all terminals/ }),
    );
    expect(callbacks.onNavigateTerminals).toHaveBeenCalledTimes(1);
  });

  it('explains an empty project scope and offers terminal creation', () => {
    const { callbacks } = renderWorkbench({
      cards: [],
      attentionItems: [],
      groups: [],
      scopeLabel: 'Repo · feature/empty',
      summary: {
        attention: 0,
        normalRunning: 0,
        review: 0,
        failed: 0,
      },
    });

    expect(screen.getByText('No terminals in this scope')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(callbacks.onCreateTerminal).toHaveBeenCalledTimes(1);
  });
});
