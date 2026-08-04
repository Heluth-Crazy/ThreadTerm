import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalTabCloseDialog } from './TerminalTabCloseDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; stage?: string }) =>
      options?.defaultValue?.replace('{{stage}}', options.stage ?? '') ?? key,
  }),
}));

describe('TerminalTabCloseDialog', () => {
  it('keeps close-tab-only as the default and starts graceful shutdown explicitly', () => {
    const onChoose = vi.fn();
    render(
      <TerminalTabCloseDialog
        open
        title="Codex"
        phase="confirm"
        onChoose={onChoose}
      />,
    );

    expect(screen.getByRole('button', { name: 'Close tab only' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'End Agent and close' }));
    expect(onChoose).toHaveBeenCalledWith('closeAndEnd');
  });

  it('does not dismiss an active graceful shutdown with Escape', () => {
    const onChoose = vi.fn();
    render(
      <TerminalTabCloseDialog
        open
        title="Codex"
        phase="gracefulEnding"
        onChoose={onChoose}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onChoose).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/waiting for the Agent and shell/i);
  });

  it('offers keep, another wait window, and explicit force after timeout', () => {
    const onChoose = vi.fn();
    render(
      <TerminalTabCloseDialog
        open
        title="Codex"
        phase="timedOut"
        stage="agentExit"
        onChoose={onChoose}
      />,
    );

    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wait 5 more seconds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Force end' }));
    expect(onChoose.mock.calls).toEqual([
      ['keepTerminal'],
      ['continueWaiting'],
      ['forceEnd'],
    ]);
  });
});
