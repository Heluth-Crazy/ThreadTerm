import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AutoRestartControls } from './AutoRestartControls';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

afterEach(() => {
  cleanup();
});

describe('AutoRestartControls', () => {
  it('keeps the toggle at a fixed square so the icon cannot squash in a tight header', () => {
    render(
      <AutoRestartControls
        enabled={false}
        maxRetries={3}
        onToggle={vi.fn()}
        onMaxRetriesChange={vi.fn()}
      />,
    );

    const toggle = screen.getByTitle('autoRestart.enable');
    expect(toggle).toHaveClass('h-7', 'w-7', 'shrink-0', 'inline-flex');
    expect(toggle.querySelector('svg')).toHaveClass('shrink-0');
    expect(screen.queryByLabelText('autoRestart.maxRetries')).not.toBeInTheDocument();
  });

  it('gives the retry select a fixed width and chevron padding so a 1-2 digit value is not crushed', () => {
    const onToggle = vi.fn();
    const onMaxRetriesChange = vi.fn();
    render(
      <AutoRestartControls
        enabled
        maxRetries={3}
        onToggle={onToggle}
        onMaxRetriesChange={onMaxRetriesChange}
      />,
    );

    const select = screen.getByLabelText('autoRestart.maxRetries');
    expect(select).toHaveClass('h-7', 'w-14', 'shrink-0', 'pr-7');
    expect(select).not.toHaveClass('px-1');
    expect(select).toHaveValue('3');

    fireEvent.change(select, { target: { value: '5' } });
    expect(onMaxRetriesChange).toHaveBeenCalledWith(5);

    fireEvent.click(screen.getByTitle('autoRestart.disable'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
