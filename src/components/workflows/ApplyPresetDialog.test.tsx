import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApplyPresetDialog } from './ApplyPresetDialog';
import type { ApplyPresetEntry } from '../../lib/workflows/dedupWorkflows';

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

function entry(name: string, state: ApplyPresetEntry['state']): ApplyPresetEntry {
  return {
    workflow: {
      name,
      command: `echo ${name}`,
      filePath: `/repo/.threadterm/workflows/${name}.yaml`,
    },
    state,
    resolvedCwd: '/repo',
    resolvedCommand: `echo ${name}`,
    missingArgs: state === 'missing-args' ? ['env'] : undefined,
    duplicateOf: state === 'duplicate' ? 'card-1' : undefined,
  };
}

describe('ApplyPresetDialog', () => {
  it('renders new, duplicate, and missing-args states', () => {
    render(
      <ApplyPresetDialog
        open
        projectName="repo"
        projectPath="/repo"
        entries={[
          entry('new-one', 'new'),
          entry('dupe-one', 'duplicate'),
          entry('args-one', 'missing-args'),
        ]}
        onCancel={vi.fn()}
        onApply={vi.fn()}
      />,
    );

    expect(screen.getByText('new-one')).toBeInTheDocument();
    expect(screen.getByText('dupe-one')).toBeInTheDocument();
    expect(screen.getByText('args-one')).toBeInTheDocument();
    expect(screen.getAllByText('Will create').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Duplicate').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Needs args').length).toBeGreaterThan(0);
  });

  it('calls onApply only when there are new entries', () => {
    const onApply = vi.fn();
    const { rerender } = render(
      <ApplyPresetDialog
        open
        projectName="repo"
        projectPath="/repo"
        entries={[entry('dupe-one', 'duplicate')]}
        onCancel={vi.fn()}
        onApply={onApply}
      />,
    );

    const disabledApply = screen.getAllByText('Apply preset').at(-1) as HTMLButtonElement;
    expect(disabledApply).toBeDisabled();

    rerender(
      <ApplyPresetDialog
        open
        projectName="repo"
        projectPath="/repo"
        entries={[entry('new-one', 'new')]}
        onCancel={vi.fn()}
        onApply={onApply}
      />,
    );
    const enabledApply = screen.getAllByText('Apply preset').at(-1) as HTMLButtonElement;
    fireEvent.click(enabledApply);
    expect(onApply).toHaveBeenCalledTimes(1);
  });
});
