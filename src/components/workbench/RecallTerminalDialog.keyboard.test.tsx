import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  makeCard,
  TestRecallTerminalDialog as RecallTerminalDialog,
} from './RecallTerminalDialog.testHarness';

describe('RecallTerminalDialog keyboard lifecycle', () => {
  it('closes on Escape', () => {
    const onConfirm = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open recall
          </button>
          <RecallTerminalDialog
            open={open}
            cards={[makeCard()]}
            followedCardIds={[]}
            selectedProjectPath={null}
            selectedWorktreePath={null}
            onClose={() => setOpen(false)}
            onConfirm={onConfirm}
          />
        </>
      );
    }

    render(<Harness />);
    const launcher = screen.getByRole('button', { name: 'Open recall' });
    launcher.focus();
    fireEvent.click(launcher);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.todo('restores focus to the launcher after closing');
});
