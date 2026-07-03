import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspacePanel } from './WorkspacePanel';
import { clearWorkspaceLoadCaches } from './workspaceLoadCache';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  gitStatus: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
  git: {
    changes: {
      status: (...args: unknown[]) => mocks.gitStatus(...args),
    },
  },
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { defaultValue?: string; count?: number; error?: string }) => {
        if (opts?.defaultValue) {
          return opts.defaultValue
            .replace('{{count}}', String(opts.count ?? ''))
            .replace('{{error}}', opts.error ?? '');
        }
        return key;
      },
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

beforeEach(() => {
  clearWorkspaceLoadCaches();
  mocks.invoke.mockResolvedValue([
    { name: 'README.md', path: '/repo/README.md', isDir: false, isHidden: false },
  ]);
  mocks.gitStatus.mockResolvedValue([
    {
      path: 'src/App.tsx',
      absolutePath: '/repo/src/App.tsx',
      repositoryRoot: '/repo',
      staged: null,
      unstaged: 'M',
      isUntracked: false,
    },
  ]);
});

afterEach(() => {
  cleanup();
  clearWorkspaceLoadCaches();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('WorkspacePanel', () => {
  it('keeps file navigation in the right panel and requests a main-content editor tab', async () => {
    const onOpenFile = vi.fn();

    render(
      <WorkspacePanel
        rootCwd="/repo"
        onClose={vi.fn()}
        onOpenFile={onOpenFile}
        onOpenDiff={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('README.md'));

    expect(onOpenFile).toHaveBeenCalledWith('/repo', {
      name: 'README.md',
      path: '/repo/README.md',
      isDir: false,
      isHidden: false,
    });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps changes navigation in the right panel and requests a main-content diff tab', async () => {
    const onOpenDiff = vi.fn();

    render(
      <WorkspacePanel
        rootCwd="/repo/subdir"
        onClose={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenDiff={onOpenDiff}
      />,
    );

    fireEvent.click(screen.getByText('Changes'));
    expect(await screen.findByText('App.tsx')).toBeInTheDocument();
    expect(screen.getByText('Mod')).toBeInTheDocument();
    expect(screen.queryByText('src/App.tsx')).toBeNull();

    fireEvent.click(screen.getByText('App.tsx'));

    await waitFor(() => {
      expect(onOpenDiff).toHaveBeenCalledWith({
        path: 'src/App.tsx',
        absolutePath: '/repo/src/App.tsx',
        repositoryRoot: '/repo',
        staged: null,
        unstaged: 'M',
        isUntracked: false,
      });
    });
    expect(screen.queryByText(/\+changed/)).toBeNull();
  });

  it('shows cached file entries immediately when a remount refresh is still pending', async () => {
    const first = render(
      <WorkspacePanel
        rootCwd="/repo"
        onClose={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );
    expect(await screen.findByText('README.md')).toBeInTheDocument();
    first.unmount();

    mocks.invoke.mockReturnValue(new Promise(() => {}));

    render(
      <WorkspacePanel
        rootCwd="/repo"
        onClose={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );

    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.queryByText('Reading directory...')).toBeNull();
  });

  it('shows cached changes immediately when a remount refresh is still pending', async () => {
    const first = render(
      <WorkspacePanel
        rootCwd="/repo"
        onClose={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Changes'));
    expect(await screen.findByText('App.tsx')).toBeInTheDocument();
    first.unmount();

    mocks.gitStatus.mockReturnValue(new Promise(() => {}));

    render(
      <WorkspacePanel
        rootCwd="/repo"
        onClose={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Changes'));

    expect(screen.getByText('App.tsx')).toBeInTheDocument();
    expect(screen.queryByText('Loading changes...')).toBeNull();
  });

  it('times out an uncached file load instead of spinning forever', async () => {
    vi.useFakeTimers();
    mocks.invoke.mockReturnValue(new Promise(() => {}));

    render(
      <WorkspacePanel
        rootCwd="/slow"
        onClose={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );

    expect(screen.getByText('Reading directory...')).toBeInTheDocument();

    vi.advanceTimersByTime(10_000);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/Workspace request timed out/)).toBeInTheDocument();
    expect(screen.queryByText('Reading directory...')).toBeNull();
  });
});
