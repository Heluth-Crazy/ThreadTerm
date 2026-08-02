import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceDiffView, WorkspaceFileEditorView } from './WorkspaceContentViews';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  gitTextDiff: vi.fn(),
  confirmDialog: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => false,
  workspaceFiles: {
    read: (...args: unknown[]) => mocks.readFile(...args),
    write: (...args: unknown[]) => mocks.writeFile(...args),
  },
  git: {
    changes: {
      textDiff: (...args: unknown[]) => mocks.gitTextDiff(...args),
    },
  },
}));

vi.mock('../../lib/workspace/draftPersistence', () => ({
  persistDesktopFileDraft: vi.fn(async () => 'idle' as const),
}));

vi.mock('./WorkspaceCodeEditor', () => ({
  WorkspaceCodeEditor: ({
    value,
    onChange,
    onSave,
  }: {
    value: string;
    onChange?: (value: string) => void;
    onSave?: () => void;
  }) => (
    <textarea
      aria-label="code editor"
      value={value}
      onChange={(event) => onChange?.(event.currentTarget.value)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          onSave?.();
        }
      }}
    />
  ),
  WorkspaceMergeDiffEditor: ({
    baseValue,
    currentValue,
    labels,
    onCurrentChange,
    onSave,
    onStatus,
  }: {
    baseValue: string;
    currentValue: string;
    labels: { revertedLine: string };
    onCurrentChange?: (value: string) => void;
    onSave?: () => void;
    onStatus?: (message: string) => void;
  }) => (
    <div>
      <pre>{baseValue}</pre>
      <textarea
        aria-label="diff editor"
        value={currentValue}
        onChange={(event) => onCurrentChange?.(event.currentTarget.value)}
      />
      <button
        type="button"
        onClick={() => {
          onCurrentChange?.(baseValue);
          onStatus?.(labels.revertedLine);
        }}
      >
        Revert line
      </button>
      <button type="button" onClick={onSave}>
        Save draft
      </button>
    </div>
  ),
}));

vi.mock('../../lib/nativeDialog', () => ({
  confirmDialog: (...args: unknown[]) => mocks.confirmDialog(...args),
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
  mocks.readFile.mockResolvedValue({
    path: '/repo/README.md',
    contents: 'old',
    sizeBytes: 3,
    modifiedUnixMs: 10,
  });
  mocks.writeFile.mockResolvedValue({
    path: '/repo/README.md',
    contents: 'new',
    sizeBytes: 3,
    modifiedUnixMs: 20,
  });
  mocks.gitTextDiff.mockResolvedValue({
    path: 'src/App.tsx',
    repositoryRoot: '/repo',
    isBinary: false,
    sections: [
      {
        kind: 'unstaged',
        baseLabel: 'Index',
        currentLabel: 'Working tree',
        baseContents: 'old\nunchanged\n',
        currentContents: 'new\nunchanged\n',
        editable: true,
        currentModifiedUnixMs: 40,
      },
    ],
  });
  mocks.confirmDialog.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WorkspaceFileEditorView', () => {
  it('loads a selected file and saves edited text with the current mtime', async () => {
    render(<WorkspaceFileEditorView rootPath="/repo" path="/repo/README.md" active />);

    const editor = await screen.findByDisplayValue('old');
    fireEvent.change(editor, { target: { value: 'new' } });
    fireEvent.click(screen.getByLabelText('Save'));

    await waitFor(() => {
      expect(mocks.writeFile).toHaveBeenCalledWith('/repo', '/repo/README.md', 'new', 10);
    });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('preserves CRLF line endings when saving an edited CRLF file', async () => {
    mocks.readFile.mockResolvedValueOnce({
      path: '/repo/README.md',
      contents: 'old\r\nline\r\n',
      sizeBytes: 11,
      modifiedUnixMs: 30,
    });

    render(<WorkspaceFileEditorView rootPath="/repo" path="/repo/README.md" active />);

    await waitFor(() => {
      expect(mocks.readFile).toHaveBeenCalledWith('/repo', '/repo/README.md');
    });
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'new\nline\n' } });
    fireEvent.click(screen.getByLabelText('Save'));

    await waitFor(() => {
      expect(mocks.writeFile).toHaveBeenCalledWith(
        '/repo',
        '/repo/README.md',
        'new\r\nline\r\n',
        30,
      );
    });
  });
});

describe('WorkspaceDiffView', () => {
  const change = {
    path: 'src/App.tsx',
    absolutePath: '/repo/src/App.tsx',
    repositoryRoot: '/repo',
    staged: null,
    unstaged: 'M',
    isUntracked: false,
  };

  it('loads and renders a main-content diff view', async () => {
    render(<WorkspaceDiffView change={change} active onOpenFile={vi.fn()} />);

    expect(await screen.findByText('Index')).toBeInTheDocument();
    expect(screen.getByText('Working tree')).toBeInTheDocument();
    expect(await screen.findByLabelText('diff editor')).toHaveValue('new\nunchanged\n');
    expect(mocks.gitTextDiff).toHaveBeenCalledWith('/repo', 'src/App.tsx');
  });

  it('requests opening the changed file from the diff toolbar', async () => {
    const onOpenFile = vi.fn();
    render(<WorkspaceDiffView change={change} active onOpenFile={onOpenFile} />);

    fireEvent.click(await screen.findByText('Open file'));

    expect(onOpenFile).toHaveBeenCalledWith('/repo', {
      name: 'App.tsx',
      path: '/repo/src/App.tsx',
      isDir: false,
      isHidden: false,
    });
  });

  it('saves edited diff draft to the working tree with the current mtime', async () => {
    render(<WorkspaceDiffView change={change} active onOpenFile={vi.fn()} />);

    const editor = await screen.findByLabelText('diff editor');
    fireEvent.change(editor, { target: { value: 'edited\nunchanged\n' } });
    fireEvent.click(screen.getByLabelText('Save'));

    await waitFor(() => {
      expect(mocks.writeFile).toHaveBeenCalledWith(
        '/repo',
        '/repo/src/App.tsx',
        'edited\nunchanged\n',
        40,
      );
    });
  });
});
