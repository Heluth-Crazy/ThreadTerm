import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useValidatedProviderSessionLaunch } from './useValidatedProviderSessionLaunch';

const bridgeMock = vi.hoisted(() => ({
  resolveResume: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  providerSessions: {
    resolveResume: bridgeMock.resolveResume,
  },
}));

function createBoundCodexCard(sessionId: string): string {
  const state = useTerminalStore.getState();
  const id = state.createCard({
    projectName: 'ThreadTerm',
    projectPath: '/repo/threadterm',
    terminalType: 'codex',
  });
  state.markProviderSessionBound(id, sessionId);
  return id;
}

function renderCardLaunch(cardId: string) {
  return renderHook(() => {
    const card = useTerminalStore(
      (state) => state.cards.find((candidate) => candidate.id === cardId) ?? null,
    );
    return useValidatedProviderSessionLaunch(card, 'codex');
  });
}

beforeEach(() => {
  bridgeMock.resolveResume.mockReset();
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    projectCardOrder: {},
  });
});

describe('useValidatedProviderSessionLaunch', () => {
  it('migrates a subagent binding to its interactive parent and resumes that history', async () => {
    const subagentId = '019f514a-8678-7c33-b6cf-3a8c40e53052';
    const parentId = '019f513b-d9ae-7833-8e9e-d878ac9e9fe5';
    const cardId = createBoundCodexCard(subagentId);
    bridgeMock.resolveResume.mockResolvedValue({
      id: parentId,
      provider: 'codex',
      projectPath: '/repo/threadterm',
      updatedAt: 1,
    });

    const { result } = renderCardLaunch(cardId);

    expect(result.current.launch).toBeNull();
    await waitFor(() => {
      expect(result.current.launch?.command).toBe(
        `codex resume ${parentId} --no-alt-screen`,
      );
    });

    expect(bridgeMock.resolveResume).toHaveBeenCalledWith('codex', subagentId);
    expect(result.current.launch?.command).not.toBe('codex --no-alt-screen');
    expect(
      useTerminalStore.getState().getCardById(cardId)?.providerSessionId,
    ).toBe(parentId);
  });

  it('resumes a validated interactive Codex session without changing its id', async () => {
    const sessionId = '019f7fa3-f711-7553-83cf-d83df858ffd8';
    const cardId = createBoundCodexCard(sessionId);
    bridgeMock.resolveResume.mockResolvedValue({
      id: sessionId,
      provider: 'codex',
      projectPath: '/repo/threadterm',
      updatedAt: 1,
    });

    const { result } = renderCardLaunch(cardId);

    await waitFor(() => {
      expect(result.current.launch?.command).toBe(
        `codex resume ${sessionId} --no-alt-screen`,
      );
    });
    expect(
      useTerminalStore.getState().getCardById(cardId)?.providerSessionId,
    ).toBe(sessionId);
  });

  it('preserves the historical binding and never starts new when resolution is unavailable', async () => {
    const sessionId = 'missing-history';
    const cardId = createBoundCodexCard(sessionId);
    bridgeMock.resolveResume.mockResolvedValue(null);

    const { result } = renderCardLaunch(cardId);

    await waitFor(() => {
      expect(result.current.status).toBe('unavailable');
    });
    expect(result.current.launch).toBeNull();
    expect(
      useTerminalStore.getState().getCardById(cardId)?.providerSessionId,
    ).toBe(sessionId);

    act(() => result.current.retry());
    await waitFor(() => {
      expect(bridgeMock.resolveResume).toHaveBeenCalledTimes(2);
    });
    expect(result.current.launch).toBeNull();
  });

  it('preserves the historical binding and never starts new when resolution errors', async () => {
    const sessionId = 'history-with-read-error';
    const cardId = createBoundCodexCard(sessionId);
    bridgeMock.resolveResume.mockRejectedValue(new Error('read failed'));

    const { result } = renderCardLaunch(cardId);

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.launch).toBeNull();
    expect(
      useTerminalStore.getState().getCardById(cardId)?.providerSessionId,
    ).toBe(sessionId);
  });
});
