import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspacePanel } from './WorkspacePanel';

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
  vi.clearAllMocks();
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
});
