import { afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AiThreadView } from './AiThreadView';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && 'defaultValue' in opts) return opts.defaultValue as string;
        return key;
      },
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

afterEach(() => {
  cleanup();
});

describe('AiThreadView', () => {
  it('renders empty state when no entries', () => {
    render(<AiThreadView entries={[]} onRunCommand={vi.fn()} />);
    expect(screen.getByTestId('ai-thread-empty')).toBeInTheDocument();
  });

  it('renders user and ai entries with role distinction', () => {
    render(
      <AiThreadView
        entries={[
          { id: 'u1', role: 'user', text: 'why?', createdAt: 1, state: 'ok' },
          { id: 'a1', role: 'ai', text: 'because', provider: 'claude', createdAt: 2, state: 'ok' },
        ]}
        onRunCommand={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ai-thread-entry-u1')).toHaveAttribute('data-role', 'user');
    expect(screen.getByTestId('ai-thread-entry-a1')).toHaveAttribute('data-role', 'ai');
  });

  it('Run-as-command requires two clicks within 1500ms', () => {
    vi.useFakeTimers();
    const onRunCommand = vi.fn();
    render(
      <AiThreadView
        entries={[
          {
            id: 'a1',
            role: 'ai',
            text: '`ls -la`',
            provider: 'claude',
            createdAt: 1,
            state: 'ok',
          },
        ]}
        onRunCommand={onRunCommand}
      />,
    );
    const btn = screen.getByTestId('ai-run-as-command-a1');
    fireEvent.click(btn);
    expect(onRunCommand).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(onRunCommand).toHaveBeenCalledWith('ls -la');
    vi.useRealTimers();
  });

  it('Run-as-command resets after 1500ms timeout', () => {
    vi.useFakeTimers();
    const onRunCommand = vi.fn();
    render(
      <AiThreadView
        entries={[
          {
            id: 'a1',
            role: 'ai',
            text: '`echo hi`',
            provider: 'claude',
            createdAt: 1,
            state: 'ok',
          },
        ]}
        onRunCommand={onRunCommand}
      />,
    );
    fireEvent.click(screen.getByTestId('ai-run-as-command-a1'));
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    fireEvent.click(screen.getByTestId('ai-run-as-command-a1'));
    expect(onRunCommand).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('extracts first fenced code block for Run-as-command', () => {
    vi.useFakeTimers();
    const onRunCommand = vi.fn();
    render(
      <AiThreadView
        entries={[
          {
            id: 'a2',
            role: 'ai',
            text: 'Try this:\n```bash\nnpm run build\n```\nThen reload.',
            provider: 'claude',
            createdAt: 1,
            state: 'ok',
          },
        ]}
        onRunCommand={onRunCommand}
      />,
    );
    const btn = screen.getByTestId('ai-run-as-command-a2');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onRunCommand).toHaveBeenCalledWith('npm run build');
    vi.useRealTimers();
  });
});
