import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  getProjectBranchesMock,
  makeCard,
  renderWorkbench,
} from './WorkbenchView.testHarness';

const projectBranchesMock = getProjectBranchesMock();

describe('WorkbenchView recall terminals', () => {
  it('recalls multiple active terminals without opening either terminal', () => {
    const { callbacks } = renderWorkbench();

    fireEvent.click(screen.getByRole('button', { name: 'Recall terminals' }));
    const dialog = screen.getByRole('dialog');
    const checkboxes = within(dialog).getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to Workbench' }));

    expect(callbacks.onFollowCards).toHaveBeenCalledWith(['card-1', 'card-2']);
    expect(callbacks.onOpenTerminal).not.toHaveBeenCalled();
  });

  it('keeps already-followed recall rows disabled and returns to all projects explicitly', () => {
    const { callbacks } = renderWorkbench({
      followedCards: [makeCard()],
      followedCardIds: ['card-1'],
      scopeLabel: 'Repo · main',
      selectedProjectPath: '/repo',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Recall terminals' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('checkbox')[0]).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));

    expect(callbacks.onShowAllProjects).toHaveBeenCalledTimes(1);
  });

  it('filters recall candidates by worktree when Windows project paths differ in form', () => {
    renderWorkbench({
      allCards: [
        makeCard({
          id: 'card-main',
          ptyId: 'card-main',
          projectPath: 'd:/repo',
          branchLabel: 'main',
        }),
        makeCard({
          id: 'card-feature',
          ptyId: 'card-feature',
          projectPath: 'd:/repo',
          worktreePath: 'd:/repo-worktrees/feature-ui',
          branchLabel: 'feature/ui',
        }),
      ],
      scopeLabel: 'Repo',
      selectedProjectPath: 'D:\\REPO\\',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Recall terminals' }));
    const dialog = screen.getByRole('dialog');
    const projectSelect = within(dialog).getByRole('combobox', {
      name: 'Project',
    }) as HTMLSelectElement;
    const worktreeSelect = within(dialog).getByRole('combobox', {
      name: 'Branch / worktree',
    }) as HTMLSelectElement;

    expect(projectSelect).toBeDisabled();
    expect(projectSelect.value).toBe('d:/repo');
    expect(
      within(worktreeSelect).getByRole('option', { name: 'feature/ui' }),
    ).toBeInTheDocument();
    fireEvent.change(
      within(dialog).getByRole('combobox', { name: 'Branch / worktree' }),
      {
        target: { value: 'path:d:/repo-worktrees/feature-ui' },
      },
    );

    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(dialog).getAllByText(/feature\/ui/)).not.toHaveLength(0);
    expect(within(dialog).queryByText(/main ·/)).toBeNull();
  });

  it('joins Git worktrees to legacy terminal branch labels before filtering', () => {
    projectBranchesMock.branches = [
      {
        branch: 'main',
        head: 'abc123',
        isCurrent: true,
        worktreePath: 'D:\\repo',
        isMainWorktree: true,
        lastCommitUnix: 1,
      },
      {
        branch: 'feature/recall',
        head: 'def456',
        isCurrent: false,
        worktreePath: 'D:\\worktrees\\feature-recall',
        isMainWorktree: false,
        lastCommitUnix: 2,
      },
    ];
    renderWorkbench({
      allCards: [
        makeCard({
          id: 'card-main',
          ptyId: 'card-main',
          projectPath: 'D:\\repo',
          branchLabel: 'main',
        }),
        makeCard({
          id: 'card-feature-a',
          ptyId: 'card-feature-a',
          projectPath: 'D:\\repo',
          branchLabel: 'feature/recall',
        }),
        makeCard({
          id: 'card-feature-b',
          ptyId: 'card-feature-b',
          projectPath: 'D:\\repo',
          branchLabel: 'feature/recall',
        }),
      ],
      scopeLabel: 'Repo',
      selectedProjectPath: 'D:\\repo',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Recall terminals' }));
    const dialog = screen.getByRole('dialog');
    const contextSelect = within(dialog).getByRole('combobox', {
      name: 'Branch / worktree',
    });

    expect(
      within(contextSelect).getAllByRole('option', { name: 'feature/recall' }),
    ).toHaveLength(1);
    fireEvent.change(contextSelect, {
      target: { value: 'path:d:/worktrees/feature-recall' },
    });

    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(dialog).queryByText(/main ·/)).toBeNull();
  });
});
