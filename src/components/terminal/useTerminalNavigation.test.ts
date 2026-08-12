import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrimaryView } from '../../lib/workbench/types';
import { useTerminalStore } from '../../stores/terminalStore';
import {
  resolveReturnPrimaryView,
  type ReturnPrimaryView,
  useTerminalNavigation,
} from './useTerminalNavigation';

beforeEach(() => {
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    focusedCardId: null,
    selectedProjectPath: null,
    selectedWorktreePath: null,
    selectedWorktreeLabel: null,
    pendingFocusCardId: null,
    pendingLocateCardId: null,
  });
});

describe('resolveReturnPrimaryView', () => {
  it.each<[
    current: PrimaryView,
    previous: ReturnPrimaryView,
    expected: ReturnPrimaryView,
  ]>([
    ['workbench', 'terminals', 'workbench'],
    ['terminals', 'workbench', 'terminals'],
    ['workspace', 'workbench', 'workbench'],
    ['workspace', 'terminals', 'terminals'],
  ])(
    'uses %s with previous %s as return destination %s',
    (current, previous, expected) => {
      expect(resolveReturnPrimaryView(current, previous)).toBe(expected);
    },
  );
});

describe('useTerminalNavigation', () => {
  it('focuses a card created after the current render using live store state', () => {
    const mountCardInBackground = vi.fn();
    const setPrimaryView = vi.fn();
    const setViewMode = vi.fn();
    const { result } = renderHook(() =>
      useTerminalNavigation({
        cards: [],
        focusedCard: undefined,
        focusedCardId: null,
        primaryView: 'workbench',
        terminalsVisible: false,
        activateTerminalForCard: vi.fn(),
        closeRightSurface: vi.fn(),
        mountCardInBackground,
        openRightSurface: vi.fn(),
        setMobileViewActive: vi.fn(),
        setPrimaryView,
        setSidebarOpen: vi.fn(),
        setViewMode,
        setWorkbenchPanel: vi.fn(),
      }),
    );

    let cardId = '';
    act(() => {
      cardId = useTerminalStore.getState().createCard({
        projectName: 'first repo',
        projectPath: 'C:\\work\\first-repo',
        terminalType: 'shell',
      });
      result.current.focusMountedCard(cardId);
    });

    expect(useTerminalStore.getState()).toMatchObject({
      focusedCardId: cardId,
      selectedProjectPath: 'C:\\work\\first-repo',
      selectedWorktreePath: null,
    });
    expect(mountCardInBackground).toHaveBeenCalledWith(cardId);
    expect(setPrimaryView).toHaveBeenCalledWith('workspace');
    expect(setViewMode).toHaveBeenCalledWith('focus');
  });
});
