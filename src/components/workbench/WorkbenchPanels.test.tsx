import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AttentionItem,
  ExecutionContextGroup,
} from '../../lib/workbench/types';
import {
  DEFAULT_WORKBENCH_RULES,
  useWorkbenchStore,
} from '../../stores/workbenchStore';
import type { TerminalCard } from '../../types/terminal';
import { WorkbenchDetailPanel } from './WorkbenchDetailPanel';
import { WorkbenchRulesPanel } from './WorkbenchRulesPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number }) => {
      const value = options?.defaultValue ?? key;
      return value.split('{{count}}').join(String(options?.count ?? ''));
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
    status: 'failed',
    createdAt: NOW - 20_000,
    lastActivity: NOW - 10_000,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: true,
    ...overrides,
  };
}

const failedItem: AttentionItem = {
  id: 'terminal_state:card-1',
  cardId: 'card-1',
  kind: 'failed',
  severity: 'critical',
  sourceKind: 'terminal_state',
  sourceId: 'card-1',
  occurredAt: NOW - 10_000,
  projectPath: '/repo',
  projectName: 'Repo',
  terminalType: 'codex',
  title: 'Repo failed',
  detail: 'Command exited with code 1',
  reasonCode: 'failed_state',
  capability: {
    openRequest: false,
    openTerminal: true,
    openNotification: false,
    openEvidence: false,
  },
};

beforeEach(() => {
  useWorkbenchStore.setState({
    rules: { ...DEFAULT_WORKBENCH_RULES },
  });
});

describe('WorkbenchRulesPanel', () => {
  it('keeps rules local, defaults no-progress detection off, and supports exclusions', () => {
    render(
      <WorkbenchRulesPanel
        cards={[
          makeCard(),
          makeCard({
            id: 'shell-card',
            ptyId: 'shell-card',
            terminalType: 'shell',
            projectName: 'Dev server',
          }),
        ]}
      />,
    );

    expect(
      screen.getByText(/never send terminal input or restart a process/i),
    ).toBeInTheDocument();

    const stalledSwitch = screen.getByRole('switch', {
      name: /No-progress detection/,
    });
    expect(stalledSwitch).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(stalledSwitch);

    expect(stalledSwitch).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('combobox')).toHaveValue('30');
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);

    fireEvent.click(screen.getByRole('checkbox', { name: /Repo/ }));
    expect(useWorkbenchStore.getState().rules.stalledExcludedCardIds).toEqual([
      'card-1',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Reset rules' }));
    expect(useWorkbenchStore.getState().rules).toEqual(DEFAULT_WORKBENCH_RULES);
  });
});

describe('WorkbenchDetailPanel', () => {
  it('shows only available evidence and keeps its footer action navigation-only', () => {
    const onOpenTerminal = vi.fn();
    const onClose = vi.fn();

    render(
      <WorkbenchDetailPanel
        panel={{ kind: 'attention', attentionId: failedItem.id }}
        attentionItems={[failedItem]}
        groups={[]}
        cards={[makeCard()]}
        notifications={[]}
        now={NOW}
        onOpenTerminal={onOpenTerminal}
        onClose={onClose}
      />,
    );

    expect(screen.getByText(/terminal state/i)).toBeInTheDocument();
    expect(
      screen.getByText('The terminal failed and has no pending automatic restart.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Terminal activity')).toBeNull();
    expect(screen.queryByText('Notifications')).toBeNull();
    expect(screen.queryByText(/cost|verified|tests passed|diff/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(onOpenTerminal).toHaveBeenCalledWith('card-1');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('contains long unbroken terminal signals inside a narrow detail panel', () => {
    const preview = `| > |\n  ${'─'.repeat(160)}`;
    const group: ExecutionContextGroup = {
      id: '/repo\u001f/repo',
      projectPath: '/repo',
      projectName: 'Repo',
      worktreePath: '/repo',
      cardIds: ['card-1'],
      terminalCount: 1,
      terminalTypes: ['codex'],
      attentionCount: 0,
      status: 'running',
      terminalStatuses: ['running'],
      lastActivity: NOW - 10_000,
      preview,
    };

    render(
      <WorkbenchDetailPanel
        panel={{ kind: 'group', groupId: group.id }}
        attentionItems={[]}
        groups={[group]}
        cards={[makeCard({ status: 'running' })]}
        notifications={[]}
        now={NOW}
        onOpenTerminal={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('workbench-detail-panel')).toHaveClass(
      'min-w-0',
      'max-w-full',
      'overflow-x-hidden',
    );
    const signal = screen.getByTestId('workbench-latest-signal');
    expect(signal).toHaveTextContent('| > |');
    expect(signal.textContent).toBe(preview);
    expect(signal).toHaveClass(
      'max-w-full',
      'overflow-hidden',
      'whitespace-pre-wrap',
      'break-all',
    );
  });

  it('contains long unbroken attention details inside the summary card', () => {
    const detail = `Fix formatting only, then re-stage and review.\n${'─'.repeat(160)}\n• Format check is clean`;
    const item: AttentionItem = { ...failedItem, detail };

    render(
      <WorkbenchDetailPanel
        panel={{ kind: 'attention', attentionId: item.id }}
        attentionItems={[item]}
        groups={[]}
        cards={[makeCard()]}
        notifications={[]}
        now={NOW}
        onOpenTerminal={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const summary = screen.getByTestId('workbench-attention-detail');
    expect(summary.textContent).toBe(detail);
    expect(summary).toHaveClass(
      'max-w-full',
      'overflow-hidden',
      'whitespace-pre-wrap',
      'break-all',
    );
  });
});
