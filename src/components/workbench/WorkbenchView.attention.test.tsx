import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import {
  approvalItem,
  failedItem,
  makeCard,
  renderWorkbench,
  reviewItem,
  stalledItem,
} from './WorkbenchView.testHarness';

describe('WorkbenchView attention and overview', () => {
  it('acknowledges a successfully opened approval item', async () => {
    const { callbacks } = renderWorkbench();

    expect(screen.getByText('Approval needed')).toBeInTheDocument();
    expect(screen.getByText('Build failed')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'View request' })[0]);
    expect(callbacks.onOpenTerminal).toHaveBeenCalledWith('card-1');
    await waitFor(() =>
      expect(callbacks.onAcknowledgeAttention).toHaveBeenCalledWith(approvalItem),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);
    expect(callbacks.onOpenAttention).toHaveBeenCalledWith(approvalItem);

    fireEvent.click(screen.getByRole('button', { name: 'Attention rules' }));
    expect(callbacks.onOpenRules).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adjust plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask steward' })).toBeNull();
  });

  it('uses a compact attention-card layout in the all-projects side rail', () => {
    renderWorkbench();

    const section = screen.getByRole('region', { name: 'Needs attention' });
    const primaryAction = within(section).getByRole('button', {
      name: 'View request',
    });
    const actions = primaryAction.parentElement;
    const card = primaryAction.closest('article');

    expect(card).toHaveAttribute('data-layout', 'compact');
    expect(card).toHaveClass('grid-cols-[28px_minmax(0,1fr)]');
    expect(actions).toHaveClass('flex-wrap');
    expect(within(actions!).getByText('3 seconds ago')).toBeInTheDocument();
  });

  it('uses a wide attention-card layout in a selected project workbench', () => {
    renderWorkbench({ selectedProjectPath: '/repo' });

    const section = screen.getByRole('region', { name: 'Needs attention' });
    const primaryAction = within(section).getByRole('button', {
      name: 'View request',
    });
    const actions = primaryAction.parentElement;
    const card = primaryAction.closest('article');

    expect(card).toHaveAttribute('data-layout', 'wide');
    expect(card).toHaveClass('grid-cols-[28px_minmax(0,1fr)_auto]');
    expect(actions).toHaveClass('flex');
    expect(actions).not.toHaveClass('flex-wrap');
  });

  it('ignores an attention item without opening the terminal', () => {
    const { callbacks } = renderWorkbench();

    fireEvent.click(screen.getAllByRole('button', { name: 'Ignore' })[0]);

    expect(callbacks.onIgnoreAttention).toHaveBeenCalledWith(approvalItem);
    expect(callbacks.onOpenTerminal).not.toHaveBeenCalled();
    expect(callbacks.onOpenAttention).not.toHaveBeenCalled();
  });

  it('acknowledges a completed result when opening it from the attention list', async () => {
    const { callbacks } = renderWorkbench({
      attentionItems: [reviewItem],
      summary: {
        attention: 1,
        normalRunning: 0,
        review: 1,
        failed: 0,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'View result' }));

    expect(callbacks.onOpenTerminal).toHaveBeenCalledWith('card-1');
    await waitFor(() =>
      expect(callbacks.onAcknowledgeAttention).toHaveBeenCalledWith(reviewItem),
    );
    expect(callbacks.onIgnoreAttention).not.toHaveBeenCalled();
  });

  it('acknowledges a completed result from the view-all dialog', async () => {
    const { callbacks } = renderWorkbench({
      attentionItems: [reviewItem],
      summary: {
        attention: 1,
        normalRunning: 0,
        review: 1,
        failed: 0,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Needs attention: 1' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'View result' }));

    expect(callbacks.onOpenTerminal).toHaveBeenCalledWith('card-1');
    await waitFor(() =>
      expect(callbacks.onAcknowledgeAttention).toHaveBeenCalledWith(reviewItem),
    );
    expect(callbacks.onIgnoreAttention).not.toHaveBeenCalled();
  });

  it.each([
    [
      'waiting-input',
      {
        ...approvalItem,
        id: 'terminal_state:card-1:waiting',
        kind: 'waiting_input' as const,
        sourceKind: 'terminal_state' as const,
        sourceId: 'card-1',
        title: 'Input needed',
        reasonCode: 'waiting_state' as const,
        capability: { ...approvalItem.capability, openRequest: false },
      },
    ],
    ['failed', failedItem],
  ])('acknowledges a successfully opened %s item', async (_kind, item) => {
    const { callbacks } = renderWorkbench({
      attentionItems: [item],
      summary: {
        attention: 1,
        normalRunning: 0,
        review: 0,
        failed: item.kind === 'failed' ? 1 : 0,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));

    await waitFor(() =>
      expect(callbacks.onAcknowledgeAttention).toHaveBeenCalledWith(item),
    );
  });

  it('keeps a completed result unacknowledged when opening does not succeed', async () => {
    const onOpenTerminal = vi.fn().mockResolvedValue(false);
    const { callbacks } = renderWorkbench({
      attentionItems: [reviewItem],
      summary: {
        attention: 1,
        normalRunning: 0,
        review: 1,
        failed: 0,
      },
      onOpenTerminal,
    });

    fireEvent.click(screen.getByRole('button', { name: 'View result' }));

    await waitFor(() =>
      expect(onOpenTerminal).toHaveBeenCalledWith('card-1'),
    );
    expect(callbacks.onAcknowledgeAttention).not.toHaveBeenCalled();
  });

  it('shows every item in the section and filters inside the view-all dialog', () => {
    renderWorkbench();

    // No filter chips outside the dialog — the section shows all items.
    const section = screen.getByRole('region', { name: 'Needs attention' });
    expect(within(section).getByText('Approval needed')).toBeInTheDocument();
    expect(within(section).getByText('Build failed')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Failed' })).toBeNull();

    fireEvent.click(within(section).getByRole('button', { name: 'View all' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Failed' }));
    expect(within(dialog).queryByText('Approval needed')).toBeNull();
    expect(within(dialog).getByText('Build failed')).toBeInTheDocument();
  });

  it('searches attention items from the header search', () => {
    renderWorkbench();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search workbench' }), {
      target: { value: 'other' },
    });

    expect(screen.queryByText('Approval needed')).toBeNull();
    expect(screen.getByText('Build failed')).toBeInTheDocument();
  });

  it('opens the attention dialog from the stat strip', () => {
    renderWorkbench();

    // The attention cell opens the dialog unfiltered; chips live inside it.
    fireEvent.click(screen.getByRole('button', { name: 'Needs attention: 2' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Approval needed')).toBeInTheDocument();
    expect(within(dialog).getByText('Build failed')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Failed' }));
    expect(within(dialog).queryByText('Approval needed')).toBeNull();
    expect(within(dialog).getByText('Build failed')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument();
  });

  it('opens terminal and followed list dialogs from the stat strip', () => {
    const { callbacks } = renderWorkbench({
      followedCards: [makeCard()],
      followedCardIds: ['card-1'],
    });

    // Terminals cell lists every terminal in scope; clicking a row opens it.
    fireEvent.click(screen.getByRole('button', { name: 'Terminals: 2' }));
    let dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Open Other terminal' }),
    );
    expect(callbacks.onOpenTerminal).toHaveBeenCalledWith('card-2');
    expect(screen.queryByRole('dialog')).toBeNull();

    // Followed cell lists followed terminals and offers recall.
    fireEvent.click(screen.getByRole('button', { name: 'Followed: 1' }));
    dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('button', { name: 'Open Repo terminal' }),
    ).toBeInTheDocument();
    // Recall hands over to the recall dialog (a dialog is still open).
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Recall terminals' }),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('explains an empty project scope and offers terminal creation', () => {
    const { callbacks } = renderWorkbench({
      cards: [],
      attentionItems: [],
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
    const stalledCard = screen.getByText('Quiet dev server').closest('article');
    expect(stalledCard).toHaveAttribute('data-layout', 'compact');

    // Stalled kind is not part of the attention filters; the chips now live
    // inside the view-all dialog.
    const section = screen.getByRole('region', { name: 'Needs attention' });
    fireEvent.click(within(section).getByRole('button', { name: 'View all' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).queryByRole('button', { name: 'No progress' }),
    ).toBeNull();
    expect(
      within(dialog).getByRole('button', { name: 'All pending' }),
    ).toBeInTheDocument();
  });

  it('opens a project scope from a pinned project card', () => {
    useWorkbenchStore.setState({ pinnedProjects: ['/alpha'] });
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

    fireEvent.click(screen.getByTitle('/alpha'));

    expect(callbacks.onSelectProject).toHaveBeenCalledWith('/alpha');
    expect(callbacks.onOpenTerminal).not.toHaveBeenCalled();
  });
});
