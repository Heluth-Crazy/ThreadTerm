import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  getProjectBranchesMock,
  makeCard,
  renderDialog,
} from './RecallTerminalDialog.testHarness';

const projectBranchesMock = getProjectBranchesMock();

describe('RecallTerminalDialog scope filtering', () => {
  it('matches Windows project and worktree paths independent of path form', () => {
    renderDialog({
      cards: [
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
      selectedProjectPath: 'D:\\REPO\\',
    });
    const dialog = screen.getByRole('dialog');
    const projectSelect = within(dialog).getByRole('combobox', {
      name: 'Project',
    }) as HTMLSelectElement;
    const contextSelect = within(dialog).getByRole('combobox', {
      name: 'Branch / worktree',
    });

    expect(projectSelect.value).toBe('d:/repo');
    fireEvent.change(contextSelect, {
      target: { value: 'path:d:/repo-worktrees/feature-ui' },
    });

    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(dialog).getAllByText(/feature\/ui/)).not.toHaveLength(0);
    expect(within(dialog).queryByText(/main ·/)).toBeNull();
  });

  it('joins Git worktrees to legacy cards by branch label', () => {
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
    renderDialog({
      cards: [
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
      selectedProjectPath: 'D:\\repo',
    });
    const dialog = screen.getByRole('dialog');
    const contextSelect = within(dialog).getByRole('combobox', {
      name: 'Branch / worktree',
    });

    expect(
      within(contextSelect).getAllByRole('option', {
        name: 'feature/recall',
      }),
    ).toHaveLength(1);
    fireEvent.change(contextSelect, {
      target: { value: 'path:d:/worktrees/feature-recall' },
    });

    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(dialog).queryByText(/main ·/)).toBeNull();
  });
});
