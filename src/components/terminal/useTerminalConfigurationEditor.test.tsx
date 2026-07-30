import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { useTerminalConfigurationEditor } from './useTerminalConfigurationEditor';

const bridgeMocks = vi.hoisted(() => ({
  isTauriEnv: vi.fn(() => true),
  resolveResume: vi.fn(),
  getSessionState: vi.fn(),
  kill: vi.fn(),
}));
const dialogMocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
}));
const claudeMocks = vi.hoisted(() => ({
  stop: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: bridgeMocks.isTauriEnv,
  providerSessions: {
    resolveResume: (...args: unknown[]) =>
      bridgeMocks.resolveResume(...args),
  },
  pty: {
    getSessionState: (...args: unknown[]) =>
      bridgeMocks.getSessionState(...args),
    kill: (...args: unknown[]) => bridgeMocks.kill(...args),
  },
}));

vi.mock('../../lib/nativeDialog', () => ({
  confirmDialog: (...args: unknown[]) =>
    dialogMocks.confirmDialog(...args),
}));

vi.mock('../../lib/claudeChat/api', () => ({
  claudeChat: {
    stop: (...args: unknown[]) => claudeMocks.stop(...args),
  },
}));

const t = ((key: string) => key) as TFunction<'terminal'>;

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    pendingTerminalConfigurations: {},
    focusedCardId: null,
    selectedProjectPath: null,
    selectedWorktreePath: null,
    selectedWorktreeLabel: null,
  });
}

function renderEditor() {
  const requestCardWorkspaceReset = vi.fn(async () => true);
  const activateTerminalForCard = vi.fn();
  const openTerminal = vi.fn();
  const hook = renderHook(() =>
    useTerminalConfigurationEditor({
      t,
      requestCardWorkspaceReset,
      activateTerminalForCard,
      openTerminal,
    }),
  );
  return {
    ...hook,
    requestCardWorkspaceReset,
    activateTerminalForCard,
    openTerminal,
  };
}

describe('useTerminalConfigurationEditor', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    bridgeMocks.isTauriEnv.mockReturnValue(true);
    bridgeMocks.getSessionState.mockResolvedValue('Running');
    bridgeMocks.kill.mockResolvedValue(undefined);
    dialogMocks.confirmDialog.mockResolvedValue(true);
    claudeMocks.stop.mockResolvedValue(undefined);
  });

  it('saves a pending edit without touching the live card or PTY', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const before = useTerminalStore.getState().getCardById(id);
    const { result } = renderEditor();

    let actionResult;
    await act(async () => {
      actionResult = await result.current.submit(
        id,
        {
          terminalType: 'codex',
          launchMode: 'custom',
          command: 'codex --no-alt-screen',
        },
        'save',
      );
    });

    expect(actionResult).toEqual({ ok: true });
    expect(useTerminalStore.getState().getCardById(id)).toBe(before);
    expect(
      useTerminalStore.getState().pendingTerminalConfigurations[id],
    ).toEqual({
      terminalType: 'codex',
      launchMode: 'custom',
      command: 'codex --no-alt-screen',
    });
    expect(dialogMocks.confirmDialog).not.toHaveBeenCalled();
    expect(bridgeMocks.getSessionState).not.toHaveBeenCalled();
    expect(bridgeMocks.kill).not.toHaveBeenCalled();
  });

  it('keeps the current terminal alive when a historical session cannot be validated', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const before = useTerminalStore.getState().getCardById(id);
    bridgeMocks.resolveResume.mockResolvedValue(null);
    const { result } = renderEditor();

    let actionResult;
    await act(async () => {
      actionResult = await result.current.submit(
        id,
        {
          terminalType: 'codex',
          launchMode: 'resume',
          providerSessionId: 'missing-session',
          workspaceMode: 'current',
        },
        'apply',
      );
    });

    expect(actionResult).toMatchObject({
      ok: false,
      kind: 'error',
      message: 'edit.sessionNotFound',
    });
    expect(useTerminalStore.getState().getCardById(id)).toBe(before);
    expect(dialogMocks.confirmDialog).not.toHaveBeenCalled();
    expect(bridgeMocks.kill).not.toHaveBeenCalled();
  });

  it('stops and rotates the PTY exactly once, then reveals the terminal view', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const oldPtyId = useTerminalStore.getState().getCardById(id)?.ptyId ?? '';
    const {
      result,
      activateTerminalForCard,
      openTerminal,
    } = renderEditor();
    const draft = {
      terminalType: 'codex' as const,
      launchMode: 'custom' as const,
      command: 'codex --no-alt-screen',
    };

    await act(async () => {
      expect(await result.current.submit(id, draft, 'apply')).toEqual({
        ok: true,
      });
    });
    const applied = useTerminalStore.getState().getCardById(id);
    expect(applied).toMatchObject({
      terminalType: 'codex',
      command: 'codex --no-alt-screen',
      status: 'idle',
    });
    expect(applied?.ptyId).not.toBe(oldPtyId);
    expect(bridgeMocks.getSessionState).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.kill).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.kill).toHaveBeenCalledWith(oldPtyId);
    expect(activateTerminalForCard).toHaveBeenCalledWith(id);
    expect(openTerminal).toHaveBeenCalledWith(id);
    expect(result.current.terminalRevealTokens[id]).toBe(1);

    await act(async () => {
      expect(await result.current.submit(id, draft, 'apply')).toEqual({
        ok: true,
      });
    });
    expect(bridgeMocks.kill).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit directory choice for a cross-project history', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    bridgeMocks.resolveResume.mockResolvedValue({
      id: 'canonical-session',
      provider: 'claude',
      projectPath: '/other-project',
    });
    const { result } = renderEditor();

    let actionResult;
    await act(async () => {
      actionResult = await result.current.submit(
        id,
        {
          terminalType: 'claude',
          launchMode: 'resume',
          providerSessionId: 'child-session',
          workspaceMode: null,
        },
        'save',
      );
    });

    expect(actionResult).toMatchObject({
      ok: false,
      kind: 'workspace-choice',
      sessionProjectPath: '/other-project',
    });
    expect(
      useTerminalStore.getState().pendingTerminalConfigurations[id],
    ).toBeUndefined();
    expect(bridgeMocks.kill).not.toHaveBeenCalled();
  });
});
