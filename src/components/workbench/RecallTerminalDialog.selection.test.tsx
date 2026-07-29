import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderDialog } from './RecallTerminalDialog.testHarness';

describe('RecallTerminalDialog selection', () => {
  it('renders nothing while closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms selected terminals in original card order and then closes', () => {
    const { callbacks } = renderDialog();
    const dialog = screen.getByRole('dialog');
    const checkboxes = within(dialog).getAllByRole('checkbox');

    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[0]);
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Add to Workbench' }),
    );

    expect(callbacks.onConfirm).toHaveBeenCalledWith(['card-1', 'card-2']);
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps followed terminals selected and disabled', () => {
    const { callbacks } = renderDialog({ followedCardIds: ['card-1'] });
    const dialog = screen.getByRole('dialog');
    const followedCheckbox = within(dialog).getAllByRole('checkbox')[0];

    expect(followedCheckbox).toBeChecked();
    expect(followedCheckbox).toBeDisabled();
    fireEvent.click(followedCheckbox);
    expect(callbacks.onConfirm).not.toHaveBeenCalled();
  });

  it('filters by search text and shows the existing empty state', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const search = within(dialog).getByRole('textbox', {
      name: 'Search active terminals',
    });

    fireEvent.change(search, { target: { value: 'feature/other' } });
    const matchingCheckboxes = within(dialog).getAllByRole('checkbox');
    expect(matchingCheckboxes).toHaveLength(1);
    expect(matchingCheckboxes[0].closest('label')).toHaveTextContent('Other');

    fireEvent.change(search, { target: { value: 'not-present' } });
    expect(
      within(dialog).getByText('No matching active terminals'),
    ).toBeInTheDocument();
  });

  it('switches from the current project scope to all projects', () => {
    renderDialog({ selectedProjectPath: '/repo' });
    const dialog = screen.getByRole('dialog');
    const scopeSelect = within(dialog).getByRole('combobox', { name: 'Scope' });
    const projectSelect = within(dialog).getByRole('combobox', {
      name: 'Project',
    }) as HTMLSelectElement;

    expect(projectSelect).toBeDisabled();
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);

    fireEvent.change(scopeSelect, { target: { value: 'all' } });

    expect(projectSelect).not.toBeDisabled();
    expect(projectSelect.value).toBe('all');
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2);
  });

});
