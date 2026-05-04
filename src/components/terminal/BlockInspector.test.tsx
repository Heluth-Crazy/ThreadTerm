import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BlockInspector } from './BlockInspector';
import type { Block } from '../../types/terminal';
import { useAiThreadStore } from '../../stores/aiThreadStore';

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

// The Tauri core module is imported transitively via aiExplain.ts — we must
// mock invoke() so the Explain button test doesn't try to hit a real bridge.
const invokeMock = vi.fn<(cmd: string, payload: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, payload: unknown) => invokeMock(cmd, payload),
}));

const saveAiSessionMarkdownFileMock = vi.fn();
vi.mock('../../lib/ai/tauriAiSessionExport', () => ({
  saveAiSessionMarkdownFile: (...args: unknown[]) => saveAiSessionMarkdownFileMock(...args),
}));

beforeEach(() => {
  invokeMock.mockReset();
  saveAiSessionMarkdownFileMock.mockReset();
  saveAiSessionMarkdownFileMock.mockResolvedValue({ kind: 'saved', path: '/tmp/threadterm-ai.md' });
  useAiThreadStore.setState({ threads: {} });
});

afterEach(() => {
  cleanup();
});

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'blk-1',
    cardId: 'card-1',
    cwd: '/home/user/project',
    command: 'npm run build',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_005_000,
    exitCode: 0,
    durationMs: 5000,
    bufferStart: 10,
    bufferEnd: 50,
    state: 'success',
    ...overrides,
  };
}

describe('BlockInspector', () => {
  it('renders null when no block is selected', () => {
    const { container } = render(<BlockInspector block={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the command text', () => {
    render(<BlockInspector block={makeBlock()} />);
    expect(screen.getByText('npm run build')).toBeTruthy();
  });

  it('renders the cwd', () => {
    render(<BlockInspector block={makeBlock()} />);
    expect(screen.getByText('/home/user/project')).toBeTruthy();
  });

  it('renders exit code 0 for success block', () => {
    render(<BlockInspector block={makeBlock({ exitCode: 0, state: 'success' })} />);
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('renders exit code 1 for failed block', () => {
    render(<BlockInspector block={makeBlock({ exitCode: 1, state: 'failed' })} />);
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('renders duration in seconds', () => {
    render(<BlockInspector block={makeBlock({ durationMs: 5000 })} />);
    expect(screen.getByText('5.0s')).toBeTruthy();
  });

  it('renders duration in minutes for long commands', () => {
    render(<BlockInspector block={makeBlock({ durationMs: 125_000 })} />);
    expect(screen.getByText('2m 5s')).toBeTruthy();
  });

  it('shows a running indicator when block is still running', () => {
    render(
      <BlockInspector
        block={makeBlock({
          state: 'running',
          finishedAt: undefined,
          exitCode: undefined,
          durationMs: undefined,
        })}
      />,
    );
    expect(screen.getByTestId('block-inspector-running')).toBeTruthy();
  });

  it('shows the AI explain button', () => {
    render(<BlockInspector block={makeBlock()} />);
    expect(screen.getByTestId('block-inspector-explain')).toBeTruthy();
  });

  it('renders a close button when onClose is provided', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<BlockInspector block={makeBlock()} onClose={onClose} />);
    const btn = getByTestId('block-inspector-close');
    btn.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not render a close button when onClose is omitted', () => {
    const { queryByTestId } = render(<BlockInspector block={makeBlock()} />);
    expect(queryByTestId('block-inspector-close')).toBeNull();
  });

  // ── Task 1: plain-text output region ───────────────────────────────────
  it('renders the plain-text output region when block.output is provided', () => {
    render(<BlockInspector block={makeBlock({ output: 'hello\nworld' })} />);
    const region = screen.getByTestId('block-inspector-output');
    expect(region.textContent).toContain('hello');
    expect(region.textContent).toContain('world');
  });

  it('hides the output region when block.output is undefined', () => {
    render(<BlockInspector block={makeBlock()} />);
    expect(screen.queryByTestId('block-inspector-output')).toBeNull();
  });

  it('hides the output region for empty string output', () => {
    render(<BlockInspector block={makeBlock({ output: '' })} />);
    expect(screen.queryByTestId('block-inspector-output')).toBeNull();
  });

  // ── Stage 6: AI Explain real invocation ────────────────────────────────
  it('clicking Explain invokes ai_explain and renders the answer entry', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      expect(cmd).toBe('ai_explain');
      return { stdout: 'short answer', stderr: '', exit_code: 0, timed_out: false };
    });
    render(<BlockInspector block={makeBlock({ id: 'b1' })} providerOverride="claude" />);
    fireEvent.click(screen.getByTestId('block-inspector-explain'));
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByText(/short answer/)).toBeInTheDocument();
    });
  });

  it('renders an error entry when the provider exits non-zero', async () => {
    invokeMock.mockImplementation(async () => ({
      stdout: '',
      stderr: 'boom',
      exit_code: 1,
      timed_out: false,
    }));
    render(<BlockInspector block={makeBlock({ id: 'b2' })} providerOverride="claude" />);
    fireEvent.click(screen.getByTestId('block-inspector-explain'));
    await waitFor(() => {
      expect(screen.getByText(/AI error:.*boom/)).toBeInTheDocument();
    });
  });

  it('exports the visible block AI thread as Markdown', async () => {
    useAiThreadStore.setState({
      threads: {
        b3: {
          blockId: 'b3',
          entries: [
            {
              id: 'q1',
              role: 'user',
              text: 'Explain this',
              createdAt: 1_700_000_000_000,
              state: 'ok',
            },
            {
              id: 'a1',
              role: 'ai',
              text: 'Use `npm test`.',
              provider: 'claude',
              createdAt: 1_700_000_001_000,
              state: 'ok',
            },
          ],
        },
      },
    });

    render(<BlockInspector block={makeBlock({ id: 'b3' })} providerOverride="claude" />);
    fireEvent.click(screen.getByTestId('ai-thread-export'));

    await waitFor(() => expect(saveAiSessionMarkdownFileMock).toHaveBeenCalledTimes(1));
    const markdown = saveAiSessionMarkdownFileMock.mock.calls[0][0] as string;
    expect(markdown).toContain('- Provider: claude');
    expect(markdown).toContain('- Session id: block:b3');
    expect(markdown).toContain('Explain this');
    expect(markdown).toContain('Use `npm test`.');
  });

  it('exports block context and output when no AI thread entries exist', async () => {
    render(
      <BlockInspector
        block={makeBlock({
          id: 'b-output',
          command: '',
          output: 'AI CLI streamed response text',
          finishedAt: 1_700_000_006_000,
        })}
        providerOverride="codex"
      />,
    );

    fireEvent.click(screen.getByTestId('ai-thread-export'));

    await waitFor(() => expect(saveAiSessionMarkdownFileMock).toHaveBeenCalledTimes(1));
    const markdown = saveAiSessionMarkdownFileMock.mock.calls[0][0] as string;
    expect(markdown).toContain('Command: Not available');
    expect(markdown).toContain('AI CLI streamed response text');
    expect(markdown).not.toContain('_No prompt or reply content is available for this session._');
  });

  it('exports prompt and reply after Explain creates the visible thread', async () => {
    invokeMock.mockImplementation(async () => ({
      stdout: 'The build failed because a dependency is missing.',
      stderr: '',
      exit_code: 0,
      timed_out: false,
    }));

    render(
      <BlockInspector
        block={makeBlock({
          id: 'b4',
          command: 'npm run build',
          output: 'Cannot find module vite',
        })}
        providerOverride="claude"
      />,
    );

    fireEvent.click(screen.getByTestId('block-inspector-explain'));

    await waitFor(() => {
      expect(screen.getByText(/The build failed because/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('ai-thread-export'));

    await waitFor(() => expect(saveAiSessionMarkdownFileMock).toHaveBeenCalledTimes(1));
    const markdown = saveAiSessionMarkdownFileMock.mock.calls[0][0] as string;
    expect(markdown).toContain('Command: npm run build');
    expect(markdown).toContain('Cannot find module vite');
    expect(markdown).toContain('The build failed because a dependency is missing.');
    expect(markdown).not.toContain('_No prompt or reply content is available for this session._');
  });
});
