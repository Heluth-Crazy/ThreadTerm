import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceContent } from './useWorkspaceContent';

const dialogMocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
}));

vi.mock('../../lib/nativeDialog', () => ({
  confirmDialog: (...args: unknown[]) =>
    dialogMocks.confirmDialog(...args),
}));

const t = ((
  key: string,
  options?: Record<string, unknown>,
) => options?.defaultValue ?? key) as TFunction<'terminal'>;

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    pendingTerminalConfigurations: {},
  });
}

describe('useWorkspaceContent terminal configuration reset', () => {
  beforeEach(() => {
    resetStore();
    dialogMocks.confirmDialog.mockReset();
  });

  it('keeps dirty workspace tabs when the user cancels a directory change', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const cards = useTerminalStore.getState().cards;
    const { result } = renderHook(() =>
      useWorkspaceContent({
        cards,
        focusedCardId: id,
        t,
      }),
    );
    act(() => {
      result.current.openWorkspaceFileForCard(id, '/repo', {
        name: 'app.ts',
        path: '/repo/app.ts',
        isDir: false,
        isHidden: false,
      });
    });
    const tabId = result.current.workspaceContentTabs[0]?.id ?? '';
    act(() => result.current.markWorkspaceTabDirty(id, tabId, true));
    dialogMocks.confirmDialog.mockResolvedValue(false);

    let allowed = true;
    await act(async () => {
      allowed = await result.current.requestCardWorkspaceReset(id);
    });

    expect(allowed).toBe(false);
    expect(result.current.workspaceContentTabs).toHaveLength(1);
    expect(dialogMocks.confirmDialog).toHaveBeenCalledTimes(1);
  });

  it('clears the card workspace only after dirty changes are confirmed', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const cards = useTerminalStore.getState().cards;
    const { result } = renderHook(() =>
      useWorkspaceContent({
        cards,
        focusedCardId: id,
        t,
      }),
    );
    act(() => {
      result.current.openWorkspaceFileForCard(id, '/repo', {
        name: 'app.ts',
        path: '/repo/app.ts',
        isDir: false,
        isHidden: false,
      });
    });
    const tabId = result.current.workspaceContentTabs[0]?.id ?? '';
    act(() => result.current.markWorkspaceTabDirty(id, tabId, true));
    dialogMocks.confirmDialog.mockResolvedValue(true);

    let allowed = false;
    await act(async () => {
      allowed = await result.current.requestCardWorkspaceReset(id);
    });

    expect(allowed).toBe(true);
    expect(result.current.workspaceContentTabs).toHaveLength(0);
  });
});
