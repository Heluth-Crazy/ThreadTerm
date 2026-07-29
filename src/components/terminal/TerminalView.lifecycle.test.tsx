import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  getShellMock,
  makeCard,
  TestTerminalView as TerminalView,
} from './TerminalView.testHarness';

const shellMock = getShellMock();

describe('TerminalView Shell lifecycle', () => {
  it('does not rerender the terminal when an unrelated parent update keeps its props unchanged', () => {
    const card = makeCard();
    const onBack = vi.fn();
    const onRemoveCard = vi.fn().mockResolvedValue(true);
    const onArchiveCard = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <TerminalView
        card={card}
        onBack={onBack}
        onRemoveCard={onRemoveCard}
        onArchiveCard={onArchiveCard}
      />,
    );

    expect(shellMock.props).toHaveLength(1);
    rerender(
      <TerminalView
        card={card}
        onBack={onBack}
        onRemoveCard={onRemoveCard}
        onArchiveCard={onArchiveCard}
      />,
    );

    expect(shellMock.props).toHaveLength(1);
    expect(shellMock.events).toEqual(['mount:claude-a']);
  });

  it('passes updated pane and command without remounting Shell', () => {
    const first = makeCard();
    const second = makeCard({
      id: 'claude-b',
      ptyId: 'claude-b',
      providerSessionId: '22222222-2222-4222-8222-222222222222',
    });

    const { rerender } = render(
      <TerminalView
        card={first}
        onBack={vi.fn()}
        onRemoveCard={async () => true}
        onArchiveCard={async () => true}
      />,
    );

    expect(screen.getByTestId('mock-shell')).toHaveAttribute('data-pane-id', 'claude-a');
    expect(screen.getByTestId('mock-shell')).toHaveAttribute(
      'data-initial-command',
      'claude --session-id 11111111-1111-4111-8111-111111111111',
    );

    rerender(
      <TerminalView
        card={second}
        onBack={vi.fn()}
        onRemoveCard={async () => true}
        onArchiveCard={async () => true}
      />,
    );

    expect(screen.getByTestId('mock-shell')).toHaveAttribute('data-pane-id', 'claude-b');
    expect(screen.getByTestId('mock-shell')).toHaveAttribute(
      'data-initial-command',
      'claude --session-id 22222222-2222-4222-8222-222222222222',
    );
    expect(shellMock.events).toEqual(['mount:claude-a']);
  });


  it('navigates back only after the guarded close or archive action succeeds', async () => {
    const onBack = vi.fn();
    const onRemoveCard = vi.fn().mockResolvedValue(false);
    const onArchiveCard = vi.fn().mockResolvedValue(true);
    render(
      <TerminalView
        card={makeCard()}
        onBack={onBack}
        onRemoveCard={onRemoveCard}
        onArchiveCard={onArchiveCard}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'view.closeTerminal' }));
    await waitFor(() => expect(onRemoveCard).toHaveBeenCalledWith('claude-a'));
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'view.archiveTerminal' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(onArchiveCard).toHaveBeenCalledWith('claude-a');
  });
});
