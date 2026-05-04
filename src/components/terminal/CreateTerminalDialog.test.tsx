import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CreateTerminalDialog } from './CreateTerminalDialog';

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: string | { defaultValue?: string }) => {
        if (typeof fallback === 'string') return fallback;
        return fallback?.defaultValue ?? key;
      },
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

afterEach(() => cleanup());

describe('CreateTerminalDialog', () => {
  it('opens workflow import for the selected project path', () => {
    const onImportWorkflow = vi.fn();
    render(
      <CreateTerminalDialog
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onImportWorkflow={onImportWorkflow}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('dialog.projectPathPlaceholder'), {
      target: { value: '/repo/threadterm' },
    });
    fireEvent.click(screen.getByText('Import workflow'));

    expect(onImportWorkflow).toHaveBeenCalledWith('/repo/threadterm', 'threadterm');
  });
});
