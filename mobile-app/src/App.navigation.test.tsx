import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_PROTOCOL_VERSION, type ServerMessage } from '@shared/mobile/bridge/protocol';
import { App, groupCardsByProject } from './App';
import { SERVER_ID_KEY, TOKEN_KEY } from './bridge/pairing';
import { I18nProvider } from './i18n';

const bridgeMocks = vi.hoisted(() => ({
  fetchSnapshot: vi.fn(),
  send: vi.fn(),
  onMessage: null as null | ((message: ServerMessage) => void),
}));

vi.mock('./bridge/useBridgeConnection', () => ({
  fetchSnapshot: (...args: unknown[]) => bridgeMocks.fetchSnapshot(...args),
  useBridgeConnection: (options: { onMessage: (message: ServerMessage) => void }) => {
    bridgeMocks.onMessage = options.onMessage;
    return {
      state: 'open',
      send: bridgeMocks.send,
      reconnect: vi.fn(),
    };
  },
}));

const snapshot: ServerMessage = {
  protocol_version: BRIDGE_PROTOCOL_VERSION,
  kind: 'snapshot',
  serverId: 'computer-a',
  cards: [],
  notifications: [],
  warmingUp: false,
  workbench: {
    generatedAt: Date.now(),
    summary: { attention: 0, normalRunning: 0, review: 0, failed: 0 },
    attentionItems: [],
    executionGroups: [],
    rules: {
      includeWaiting: true,
      includeFailed: true,
      includeCompletedReview: true,
      stalledEnabled: true,
      stalledThresholdMinutes: 15,
      stalledExcludedCount: 0,
    },
    capabilities: {
      openTerminal: true,
      respondToStructuredRequest: false,
      updateRules: false,
      updateNotificationReadState: false,
    },
  },
};

describe('mobile App navigation', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.sessionStorage.setItem(TOKEN_KEY, 'device-token');
    window.sessionStorage.setItem(SERVER_ID_KEY, 'computer-a');
    bridgeMocks.fetchSnapshot.mockResolvedValue(snapshot);
    bridgeMocks.send.mockReset();
    bridgeMocks.onMessage = null;
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('opens on Workbench and keeps three root tabs with full-screen push routes', async () => {
    render(
      <I18nProvider search="?lang=zh-CN">
        <App />
      </I18nProvider>,
    );

    expect(await screen.findByRole('heading', { name: '工作台' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '工作台' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '工作区' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '通知' }));
    expect(await screen.findByRole('heading', { name: '通知' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '工作台' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.getByRole('button', { name: '工作台' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '工作区' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '工作区' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '工作区' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps worktrees in the same project as separate terminal groups', () => {
    const baseCard = {
      status: 'running' as const,
      projectPath: 'D:\\repo',
      projectName: 'Repo',
      terminalType: 'shell',
      lastReplyPreview: '',
      summaryLine: null,
      hiddenLineCount: 0,
      recentOutputBytes: 0,
    };

    const groups = groupCardsByProject([
      { ...baseCard, id: 'main', worktreePath: 'D:\\repo' },
      { ...baseCard, id: 'feature', worktreePath: 'D:\\repo\\.worktrees\\feature' },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.worktreePath).sort()).toEqual(
      ['D:\\repo\\.worktrees\\feature', 'D:\\repo'].sort(),
    );
  });

  it('does not repeat the project name in terminal scope labels', async () => {
    bridgeMocks.fetchSnapshot.mockResolvedValue({
      ...snapshot,
      cards: [
        {
          id: 'main',
          status: 'running',
          projectPath: 'D:\\Test',
          projectName: 'Test',
          worktreePath: 'D:\\Test',
          terminalType: 'shell',
          lastReplyPreview: '',
          summaryLine: null,
          hiddenLineCount: 0,
          recentOutputBytes: 0,
        },
        {
          id: 'feature',
          status: 'running',
          projectPath: 'D:\\Test',
          projectName: 'Test',
          worktreePath: 'D:\\Test\\.worktrees\\mobile',
          branchLabel: 'feature/mobile',
          terminalType: 'codex',
          lastReplyPreview: '',
          summaryLine: null,
          hiddenLineCount: 0,
          recentOutputBytes: 0,
        },
      ],
    });

    render(
      <I18nProvider search="?lang=zh-CN">
        <App />
      </I18nProvider>,
    );

    expect(await screen.findByRole('heading', { name: '工作台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '工作区' }));

    const scope = await screen.findByRole('combobox', { name: '筛选项目' });
    expect(within(scope).getByRole('option', { name: 'Test' })).toBeInTheDocument();
    expect(
      within(scope).getByRole('option', { name: 'Test · feature/mobile' }),
    ).toBeInTheDocument();
    expect(within(scope).queryByRole('option', { name: 'Test · Test' })).not.toBeInTheDocument();
  });

  it('sends a custom command byte-for-byte while only validating surrounding whitespace', async () => {
    window.sessionStorage.setItem('threadterm.bridgePermission', 'full');
    render(
      <I18nProvider search="?lang=zh-CN">
        <App />
      </I18nProvider>,
    );

    expect(await screen.findByRole('heading', { name: '工作台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '工作区' }));
    fireEvent.click(within(await screen.findByRole('banner')).getByRole('button', {
      name: '新建会话',
    }));
    fireEvent.change(screen.getByRole('textbox', { name: '项目路径' }), {
      target: { value: '  D:\\Repo\\App  ' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '终端类型' }), {
      target: { value: 'custom' },
    });
    const rawCommand = '  tool.exe  --flag="a b"   --last  ';
    fireEvent.change(screen.getByRole('textbox', { name: '命令' }), {
      target: { value: rawCommand },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    expect(bridgeMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'spawn',
      terminal_type: 'custom',
      project_path: 'D:\\Repo\\App',
      command: rawCommand,
    }));
  });

  it('asks the desktop for a full terminal refresh once when mobile output has a gap', async () => {
    render(
      <I18nProvider search="?lang=zh-CN">
        <App />
      </I18nProvider>,
    );
    expect(await screen.findByRole('heading', { name: '工作台' })).toBeInTheDocument();

    act(() => {
      bridgeMocks.onMessage?.({
        ...snapshot,
        runtimeId: 'runtime-a',
        streamSeq: 5,
      });
      bridgeMocks.onMessage?.({
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        kind: 'terminal_output',
        card_id: 'card-1',
        data: 'frame with a gap',
        seq: 20,
        runtimeId: 'runtime-a',
        streamSeq: 7,
      });
      bridgeMocks.onMessage?.({
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        kind: 'terminal_output',
        card_id: 'card-1',
        data: 'another frame while recovery is pending',
        seq: 21,
        runtimeId: 'runtime-a',
        streamSeq: 9,
      });
    });

    expect(bridgeMocks.send).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.send).toHaveBeenCalledWith({ kind: 'terminal_resync' });
  });

  it('forgets the credential when the responding computer identity changes', async () => {
    bridgeMocks.fetchSnapshot.mockResolvedValue({
      ...snapshot,
      serverId: 'computer-b',
    });

    render(
      <I18nProvider search="?lang=zh-CN">
        <App />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
      expect(window.sessionStorage.getItem(SERVER_ID_KEY)).toBeNull();
    });
  });
});
