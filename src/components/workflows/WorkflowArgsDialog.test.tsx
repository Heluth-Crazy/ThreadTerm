import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkflowArgsDialog } from './WorkflowArgsDialog';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

afterEach(() => cleanup());

describe('WorkflowArgsDialog', () => {
  it('collects missing argument values before submitting', () => {
    const onSubmit = vi.fn();
    render(
      <WorkflowArgsDialog
        open
        workflow={{
          name: 'deploy',
          command: 'deploy {{env}}',
          arguments: [{ name: 'env', description: 'Target environment' }],
        }}
        missingArgs={['env']}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByText('Target environment')).toBeInTheDocument();
    const run = screen.getByText('Run');
    expect(run).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' staging ' } });
    expect(run).not.toBeDisabled();
    fireEvent.click(run);
    expect(onSubmit).toHaveBeenCalledWith({ env: 'staging' });
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <WorkflowArgsDialog
        open={false}
        workflow={null}
        missingArgs={[]}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
