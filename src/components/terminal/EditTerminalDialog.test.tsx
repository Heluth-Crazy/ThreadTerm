import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import { EditTerminalDialog } from './EditTerminalDialog';

const bridgeMocks = vi.hoisted(() => ({
  listAgentSessions: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  providerSessions: {
    listAgentSessions: (...args: unknown[]) =>
      bridgeMocks.listAgentSessions(...args),
  },
  pty: {
    kill: vi.fn(),
  },
}));

function makeCard(overrides: Partial<TerminalCard> = {}): TerminalCard {
  return {
    id: 'card-1',
    ptyId: 'pty-1',
    projectPath: '/repo',
    projectName: 'repo',
    terminalType: 'shell',
    status: 'idle',
    createdAt: 1,
    lastActivity: 1,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    ...overrides,
  };
}

describe('EditTerminalDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      cards: [],
      archivedCards: [],
      pendingTerminalConfigurations: {},
    });
  });

  it('selects a current-project history and submits a save-only draft', async () => {
    const card = makeCard();
    useTerminalStore.setState({ cards: [card] });
    bridgeMocks.listAgentSessions.mockResolvedValue({
      provider: 'codex',
      availability: 'available',
      items: [
        {
          provider: 'codex',
          id: 'codex-session-1',
          projectPath: '/repo',
          nativeTitle: 'Historical task',
          titleKind: 'explicit',
          updatedAt: 100,
          resumable: true,
        },
      ],
      nextCursor: null,
      scannedAt: 100,
    });
    const onSubmit = vi.fn(async () => ({ ok: true as const }));
    const onClose = vi.fn();

    render(
      <EditTerminalDialog
        open
        card={card}
        onClose={onClose}
        onSubmit={onSubmit}
        onDiscardPending={vi.fn()}
        onLocateConflict={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复会话' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Historical task/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: '仅保存' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      card.id,
      expect.objectContaining({
        terminalType: 'codex',
        launchMode: 'resume',
        providerSessionId: 'codex-session-1',
        workspaceMode: 'current',
        sessionProjectPath: '/repo',
      }),
      'save',
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('requires a directory choice before submitting a cross-project history', async () => {
    const card = makeCard();
    useTerminalStore.setState({ cards: [card] });
    bridgeMocks.listAgentSessions.mockResolvedValue({
      provider: 'claude',
      availability: 'available',
      items: [
        {
          provider: 'claude',
          id: 'claude-session-1',
          projectPath: '/other',
          nativeTitle: 'Other project task',
          titleKind: 'explicit',
          updatedAt: 100,
          resumable: true,
        },
      ],
      nextCursor: null,
      scannedAt: 100,
    });
    const onSubmit = vi.fn(async () => ({ ok: true as const }));

    render(
      <EditTerminalDialog
        open
        card={card}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onDiscardPending={vi.fn()}
        onLocateConflict={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Claude' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复会话' }));
    fireEvent.click(screen.getByRole('button', { name: '全部本机' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Other project task/ }),
    );

    expect(
      screen.getByRole('button', { name: '仅保存' }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: /保留当前目录/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: '仅保存' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        card.id,
        expect.objectContaining({
          providerSessionId: 'claude-session-1',
          workspaceMode: 'current',
          sessionProjectPath: '/other',
        }),
        'save',
      ),
    );
  });

  it('loads and discards an existing pending configuration explicitly', () => {
    const card = makeCard();
    const onDiscardPending = vi.fn();
    const onClose = vi.fn();

    render(
      <EditTerminalDialog
        open
        card={card}
        pendingConfiguration={{
          terminalType: 'codex',
          launchMode: 'custom',
          command: 'codex --no-alt-screen',
        }}
        onClose={onClose}
        onSubmit={vi.fn()}
        onDiscardPending={onDiscardPending}
        onLocateConflict={vi.fn()}
      />,
    );

    expect(
      screen.getByDisplayValue('codex --no-alt-screen'),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: '丢弃待应用修改' }),
    );
    expect(onDiscardPending).toHaveBeenCalledWith(card.id);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not reset an in-progress edit when live output refreshes the card', () => {
    const card = makeCard();
    const props = {
      open: true,
      onClose: vi.fn(),
      onSubmit: vi.fn(),
      onDiscardPending: vi.fn(),
      onLocateConflict: vi.fn(),
    };
    const { rerender } = render(
      <EditTerminalDialog
        {...props}
        card={card}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '运行命令' }));
    fireEvent.change(screen.getByPlaceholderText('输入要准确执行的命令'), {
      target: { value: 'codex --dangerously-bypass-approvals-and-sandbox' },
    });

    rerender(
      <EditTerminalDialog
        {...props}
        card={{
          ...card,
          lastOutput: 'streamed output',
          lastActivity: card.lastActivity + 1,
        }}
      />,
    );

    expect(
      screen.getByDisplayValue(
        'codex --dangerously-bypass-approvals-and-sandbox',
      ),
    ).toBeInTheDocument();
  });

  it('loads additional local history pages without replacing earlier results', async () => {
    const card = makeCard();
    useTerminalStore.setState({ cards: [card] });
    bridgeMocks.listAgentSessions
      .mockResolvedValueOnce({
        provider: 'codex',
        availability: 'available',
        items: [
          {
            provider: 'codex',
            id: 'page-one',
            projectPath: '/repo',
            nativeTitle: 'First page task',
            titleKind: 'explicit',
            resumable: true,
          },
        ],
        nextCursor: 'page-2',
        scannedAt: 100,
      })
      .mockResolvedValueOnce({
        provider: 'codex',
        availability: 'available',
        items: [
          {
            provider: 'codex',
            id: 'page-two',
            projectPath: '/repo',
            nativeTitle: 'Second page task',
            titleKind: 'explicit',
            resumable: true,
          },
        ],
        nextCursor: null,
        scannedAt: 200,
      });

    render(
      <EditTerminalDialog
        open
        card={card}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        onDiscardPending={vi.fn()}
        onLocateConflict={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复会话' }));

    expect(
      await screen.findByRole('button', { name: /First page task/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));

    expect(
      await screen.findByRole('button', { name: /Second page task/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /First page task/ }),
    ).toBeInTheDocument();
    expect(bridgeMocks.listAgentSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'page-2' }),
    );
  });
});
