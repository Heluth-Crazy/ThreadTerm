import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { WorkspaceShell } from './WorkspaceShell';
import { TerminalCloseSheet } from './TerminalCloseSheet';
import { DirtyFileCloseSheet } from './DirtyFileCloseSheet';
import { FileEditor } from './FileEditor';
import { DiffViewer } from './DiffViewer';
import { syntheticTabsFromCards } from './types';
import type { FileEditorModel } from './types';

vi.mock('../MainTerminal', () => ({
  MainTerminal: ({ activeCardId }: { activeCardId: string | null }) => (
    <div data-testid="mock-terminal">{activeCardId}</div>
  ),
}));

vi.mock('../input/InputBar', () => ({
  InputBar: ({ disabled, onSend }: { disabled: boolean; onSend: (d: string) => void }) => (
    <button type="button" disabled={disabled} onClick={() => onSend('x')} data-testid="mock-input">
      input
    </button>
  ),
}));

afterEach(() => {
  cleanup();
});

const cards = [
  {
    id: 'card-1',
    status: 'running' as const,
    projectPath: 'D:\\repo',
    projectName: 'Repo',
    worktreePath: 'D:\\repo',
    terminalType: 'shell',
    lastReplyPreview: '',
    summaryLine: null,
    hiddenLineCount: 0,
    recentOutputBytes: 0,
  },
];

function renderShell(
  overrides: Partial<Parameters<typeof WorkspaceShell>[0]> = {},
) {
  const tabs = syntheticTabsFromCards({
    workspaceKey: 'ws-1',
    projectName: 'Repo',
    worktreePath: 'D:\\repo',
    cards,
  });
  const onSelectTab = vi.fn();
  const onTerminalCloseChoice = vi.fn();
  const onDirtyCloseChoice = vi.fn();
  render(
    <I18nProvider search="?lang=en">
      <WorkspaceShell
        workspaceId="ws-1"
        projectName="Repo"
        projectPath="D:\\repo"
        worktreePath="D:\\repo"
        tabs={tabs}
        deviceActiveTabId="home"
        cards={cards}
        permission="full"
        secureReady={false}
        wsStatus="open"
        canSend
        onBack={vi.fn()}
        onSelectTab={onSelectTab}
        onCloseTab={vi.fn()}
        onOpenTerminalCard={vi.fn()}
        onTerminalCloseChoice={onTerminalCloseChoice}
        onDirtyCloseChoice={onDirtyCloseChoice}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { onSelectTab, onTerminalCloseChoice, onDirtyCloseChoice, tabs };
}

describe('WorkspaceShell navigation', () => {
  it('renders home and shared tab strip with independent device active tab', () => {
    renderShell({ deviceActiveTabId: 'home' });
    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-home')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tab-strip')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-files-blocked')).toBeInTheDocument();
  });

  it('blocks files banner when secure is not ready; hides when ready', () => {
    const { unmount } = render(
      <I18nProvider search="?lang=en">
        <WorkspaceShell
          workspaceId="ws-1"
          projectName="Repo"
          projectPath="D:\\repo"
          worktreePath="D:\\repo"
          tabs={syntheticTabsFromCards({
            workspaceKey: 'ws-1',
            projectName: 'Repo',
            worktreePath: 'D:\\repo',
            cards,
          })}
          deviceActiveTabId="home"
          cards={cards}
          permission="read_only"
          secureReady
          wsStatus="open"
          canSend={false}
          onBack={vi.fn()}
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
          onOpenTerminalCard={vi.fn()}
          onTerminalCloseChoice={vi.fn()}
          onDirtyCloseChoice={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.queryByTestId('workspace-files-blocked')).not.toBeInTheDocument();
    unmount();
  });

  it('opens terminal pane when device active tab is a terminal', () => {
    const tabs = syntheticTabsFromCards({
      workspaceKey: 'ws-1',
      projectName: 'Repo',
      worktreePath: 'D:\\repo',
      cards,
    });
    const terminalTab = tabs.find((tab) => tab.kind === 'terminal')!;
    renderShell({ deviceActiveTabId: terminalTab.id, tabs });
    expect(screen.getByTestId('workspace-terminal-pane')).toBeInTheDocument();
    expect(screen.getByTestId('mock-terminal')).toHaveTextContent('card-1');
  });
});

describe('close sheets permission UI', () => {
  it('hides end-terminal for read-only', () => {
    render(
      <I18nProvider search="?lang=en">
        <TerminalCloseSheet
          open
          title="shell"
          canEndTerminal={false}
          onChoose={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('terminal-end-blocked')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-close-and-end')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-close-tab-only')).toBeInTheDocument();
  });

  it('shows 3-way terminal close for full control', () => {
    const onChoose = vi.fn();
    render(
      <I18nProvider search="?lang=en">
        <TerminalCloseSheet open title="shell" canEndTerminal onChoose={onChoose} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByTestId('terminal-close-and-end'));
    expect(onChoose).toHaveBeenCalledWith('closeAndEnd');
  });

  it('offers keep, wait, and explicit force after a graceful timeout', () => {
    const onChoose = vi.fn();
    render(
      <I18nProvider search="?lang=en">
        <TerminalCloseSheet
          open
          title="shell"
          phase="timedOut"
          stage="agentExit"
          canEndTerminal
          onChoose={onChoose}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Keep terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wait 5 more seconds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Force end' }));
    expect(onChoose.mock.calls).toEqual([
      ['keepTerminal'],
      ['continueWaiting'],
      ['forceEnd'],
    ]);
  });

  it('keeps the safe keep-terminal action when control is lost during shutdown', () => {
    render(
      <I18nProvider search="?lang=en">
        <TerminalCloseSheet
          open
          title="shell"
          phase="timedOut"
          canEndTerminal={false}
          onChoose={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole('button', { name: 'Keep terminal' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wait 5 more seconds' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Force end' })).not.toBeInTheDocument();
  });

  it('keeps the close sheet open until the desktop returns an authoritative result', async () => {
    const tabs = syntheticTabsFromCards({
      workspaceKey: 'ws-1',
      projectName: 'Repo',
      worktreePath: 'D:\\repo',
      cards,
    });
    const terminalTab = tabs.find((tab) => tab.kind === 'terminal')!;
    const onTerminalCloseChoice = vi.fn().mockResolvedValue({
      outcome: 'timedOut',
      attemptId: 'attempt-1',
      stage: 'agentExit',
    });
    renderShell({
      tabs,
      deviceActiveTabId: terminalTab.id,
      onTerminalCloseChoice,
    });

    fireEvent.click(screen.getByRole('button', { name: `Close ${terminalTab.title}` }));
    fireEvent.click(screen.getByTestId('terminal-close-and-end'));

    expect(screen.getByText(/waiting for the Agent and shell/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/did not exit within 5 seconds/i)).toBeInTheDocument();
    });
    expect(onTerminalCloseChoice).toHaveBeenCalledWith(
      'closeAndEnd',
      terminalTab.id,
      'card-1',
      undefined,
    );
    expect(screen.getByTestId('terminal-close-sheet')).toBeInTheDocument();
  });

  it('blocks dirty save/discard for read-only', () => {
    render(
      <I18nProvider search="?lang=en">
        <DirtyFileCloseSheet
          open
          titles={['a.ts']}
          canMutate={false}
          onChoose={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('dirty-close-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('dirty-save-and-close')).not.toBeInTheDocument();
  });
});

describe('file editor offline/unsynced', () => {
  const baseModel: FileEditorModel = {
    workspaceId: 'ws',
    tabId: 't1',
    relativePath: 'src/a.ts',
    title: 'a.ts',
    contents: 'hello',
    authoritativeRevision: 1,
    pendingRevision: null,
    syncLabel: 'synced',
    dirty: false,
    conflict: 'none',
    readOnly: false,
    leaseHolder: null,
    hasLease: true,
    unsyncedLocal: false,
  };

  it('marks unsynced state and keeps textarea memory-only', () => {
    const onChange = vi.fn();
    render(
      <I18nProvider search="?lang=en">
        <FileEditor
          model={{ ...baseModel, syncLabel: 'unsynced', unsyncedLocal: true, dirty: true }}
          onChange={onChange}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('file-unsynced-banner')).toBeInTheDocument();
    expect(screen.getByTestId('file-sync-label')).toHaveTextContent(/unsynced/i);
    fireEvent.change(screen.getByTestId('file-editor-textarea'), {
      target: { value: 'hello world' },
    });
    expect(onChange).toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it('locks textarea when read-only or without lease', () => {
    render(
      <I18nProvider search="?lang=en">
        <FileEditor
          model={{ ...baseModel, readOnly: true, hasLease: false }}
          onChange={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('file-editor-textarea')).toHaveAttribute('readonly');
    expect(screen.getByTestId('file-readonly-pill')).toBeInTheDocument();
  });
});

describe('DiffViewer modes', () => {
  it('switches original / current / diff', () => {
    const onModeChange = vi.fn();
    render(
      <I18nProvider search="?lang=en">
        <DiffViewer
          model={{
            workspaceId: 'ws',
            tabId: 'd1',
            title: 'a.ts',
            relativePath: 'a.ts',
            original: 'a',
            current: 'b',
            diffText: '- a\n+ b',
            mode: 'diff',
            readOnly: true,
          }}
          onModeChange={onModeChange}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByTestId('diff-mode-original'));
    expect(onModeChange).toHaveBeenCalledWith('original');
    expect(screen.getByTestId('diff-readonly')).toBeInTheDocument();
  });
});
