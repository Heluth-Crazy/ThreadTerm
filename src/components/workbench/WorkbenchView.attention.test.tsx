import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  approvalItem,
  executionGroup,
  makeCard,
  renderWorkbench,
  runningGroup,
  stalledItem,
} from './WorkbenchView.testHarness';

describe('WorkbenchView attention and overview', () => {
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

  it('keeps stalled items out of the attention list in a collapsed watch section', () => {
    renderWorkbench({ stalledItems: [stalledItem] });

    // The actionable list stays pure; the watch section shows only the count.
    expect(screen.queryByText('Quiet dev server')).toBeNull();
    const toggle = screen.getByRole('button', {
      name: /No-progress watch/,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Quiet dev server')).toBeInTheDocument();

    // Stalled kind is not part of the attention filter chips anymore.
    expect(screen.queryByRole('button', { name: 'No progress' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'All pending' }),
    ).toBeInTheDocument();
  });

  it('opens a project scope from the global project overview', () => {
    const { callbacks } = renderWorkbench({
      projectOverviews: [
        {
          projectPath: '/alpha',
          projectName: 'Project Alpha',
          followedCount: 1,
          runningCount: 2,
          attentionCount: 3,
          reviewCount: 1,
          failedCount: 0,
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /Project Alpha/ }));

    expect(callbacks.onSelectProject).toHaveBeenCalledWith('/alpha');
    expect(callbacks.onOpenTerminal).not.toHaveBeenCalled();
  });
});
