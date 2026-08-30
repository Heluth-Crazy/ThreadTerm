import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTab } from '../../lib/workspace/types';
import { useTerminalStore } from '../../stores/terminalStore';
import { useTerminalRecovery } from './useTerminalRecovery';

const opened = { outcome: 'opened' as const, tab: {
  id: 'terminal:card', workspaceId: 'workspace', kind: 'terminal' as const,
  title: 'terminal', cardId: 'card', sharedOrder: 0,
  createdAtUnixMs: 0, updatedAtUnixMs: 0,
} satisfies WorkspaceTab };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function resetStore() {
  useTerminalStore.setState({
    cards: [], archivedCards: [], focusedCardId: null,
    selectedProjectPath: null, selectedWorktreePath: null, selectedWorktreeLabel: null,
    notifications: [],
  });
}

function createCard(projectPath = '/repo') {
  return useTerminalStore.getState().createCard({
    projectName: 'repo', projectPath, terminalType: 'shell',
  });
}

function renderRecovery(overrides: Partial<Parameters<typeof useTerminalRecovery>[0]> = {}) {
  const defaults = {
    mountCard: vi.fn(),
    prepareTerminalTabForFocus: vi.fn().mockResolvedValue(opened),
    commitPreparedTerminalFocus: vi.fn(),
    activateExistingWorkspaceTab: vi.fn().mockResolvedValue(null),
    invalidateWorkspace: vi.fn(),
    focusMountedCard: vi.fn(),
    reportFailure: vi.fn(),
  };
  const options = { ...defaults, ...overrides };
  const hook = renderHook(() => useTerminalRecovery(options));
  return { ...options, hook };
}

beforeEach(resetStore);

describe('useTerminalRecovery', () => {
  it('restores an archived identity, prepares one terminal tab, then focuses it', async () => {
    const cardId = createCard();
    useTerminalStore.getState().archiveCard(cardId);
    const order: string[] = [];
    const prepare = vi.fn().mockImplementation(async () => {
      order.push('prepare');
      return opened;
    });
    const commit = vi.fn((id: string) => {
      expect(id).toBe(cardId);
      order.push('commit');
    });
    const focus = vi.fn((id: string) => {
      expect(id).toBe(cardId);
      order.push('focus');
    });
    const { hook, mountCard } = renderRecovery({
      prepareTerminalTabForFocus: prepare,
      commitPreparedTerminalFocus: commit,
      focusMountedCard: focus,
    });

    let result = false;
    await act(async () => { result = await hook.result.current(cardId); });

    expect(result).toBe(true);
    expect(useTerminalStore.getState().cards.map((card) => card.id)).toEqual([cardId]);
    expect(useTerminalStore.getState().archivedCards).toHaveLength(0);
    expect(mountCard).toHaveBeenCalledWith(cardId);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(cardId);
    expect(focus).toHaveBeenCalledWith(cardId);
    expect(order).toEqual(['prepare', 'commit', 'focus']);
  });

  it('joins repeated same-card recovery requests into one operation', async () => {
    const cardId = createCard();
    const gate = deferred<typeof opened>();
    const { hook, prepareTerminalTabForFocus, focusMountedCard } = renderRecovery({
      prepareTerminalTabForFocus: vi.fn().mockReturnValue(gate.promise),
    });

    const first = hook.result.current(cardId);
    const second = hook.result.current(cardId);
    expect(second).toBe(first);
    gate.resolve(opened);
    await act(async () => { await first; });

    expect(prepareTerminalTabForFocus).toHaveBeenCalledTimes(1);
    expect(focusMountedCard).toHaveBeenCalledTimes(1);
  });

  it('invalidates a stale exact tab ref and falls back to canonical preparation', async () => {
    const cardId = createCard();
    const { hook, activateExistingWorkspaceTab, invalidateWorkspace, prepareTerminalTabForFocus } = renderRecovery();

    await act(async () => {
      await hook.result.current(cardId, {
        kind: 'workspaceTab',
        ref: { workspaceId: 'stale', rootPath: '/repo', tabId: 'terminal:gone', kind: 'terminal', cardId, relativePath: null },
        canContinue: () => true,
      });
    });

    expect(activateExistingWorkspaceTab).toHaveBeenCalledTimes(1);
    expect(invalidateWorkspace).toHaveBeenCalledWith('stale');
    expect(prepareTerminalTabForFocus).toHaveBeenCalledTimes(1);
  });

  it('does not focus or fall back when exact activation is cancelled by its caller', async () => {
    const cardId = createCard();
    const tab = { ...opened.tab, cardId };
    const { hook, invalidateWorkspace, prepareTerminalTabForFocus, focusMountedCard } = renderRecovery({
      activateExistingWorkspaceTab: vi.fn().mockResolvedValue(tab),
    });

    await act(async () => {
      expect(await hook.result.current(cardId, {
        kind: 'workspaceTab',
        ref: { workspaceId: 'workspace', rootPath: '/repo', tabId: tab.id, kind: 'terminal', cardId, relativePath: null },
        canContinue: () => false,
      })).toBe(false);
    });

    expect(focusMountedCard).not.toHaveBeenCalled();
    expect(prepareTerminalTabForFocus).not.toHaveBeenCalled();
    expect(invalidateWorkspace).not.toHaveBeenCalled();
  });

  it('keeps the latest cross-card intent when a late exact activation is stale', async () => {
    const firstId = createCard('/first');
    const secondId = createCard('/second');
    const gate = deferred<WorkspaceTab | null>();
    const { hook, prepareTerminalTabForFocus, focusMountedCard } = renderRecovery({
      activateExistingWorkspaceTab: vi.fn().mockReturnValue(gate.promise),
    });

    const first = hook.result.current(firstId, {
      kind: 'workspaceTab',
      ref: { workspaceId: 'first', rootPath: '/first', tabId: 'terminal:first', kind: 'terminal', cardId: firstId, relativePath: null },
      canContinue: () => true,
    });
    const second = hook.result.current(secondId);
    await act(async () => { await second; });
    gate.resolve(null);
    await act(async () => { expect(await first).toBe(false); });

    expect(prepareTerminalTabForFocus).toHaveBeenCalledTimes(1);
    expect(prepareTerminalTabForFocus).toHaveBeenCalledWith(
      expect.objectContaining({ id: secondId }),
    );
    expect(focusMountedCard).toHaveBeenCalledTimes(1);
    expect(focusMountedCard).toHaveBeenCalledWith(secondId);
  });

  it('starts a fresh A operation after A → B → A and keeps it coalescible', async () => {
    const firstId = createCard('/first');
    const secondId = createCard('/second');
    const staleExact = deferred<WorkspaceTab | null>();
    const freshPrepare = deferred<typeof opened>();
    const prepareTerminalTabForFocus = vi.fn((card: { id: string }) => {
      if (card.id === firstId) return freshPrepare.promise;
      return Promise.resolve(opened);
    });
    const { hook, focusMountedCard } = renderRecovery({
      prepareTerminalTabForFocus,
      activateExistingWorkspaceTab: vi.fn().mockReturnValue(staleExact.promise),
    });

    const staleA = hook.result.current(firstId, {
      kind: 'workspaceTab',
      ref: { workspaceId: 'first', rootPath: '/first', tabId: 'terminal:first', kind: 'terminal', cardId: firstId, relativePath: null },
      canContinue: () => true,
    });
    await act(async () => { await hook.result.current(secondId); });

    const freshA = hook.result.current(firstId);
    staleExact.resolve(null);
    await act(async () => { await Promise.resolve(); });
    // The stale finally must not erase A's replacement while it is pending.
    expect(hook.result.current(firstId)).toBe(freshA);
    freshPrepare.resolve(opened);
    await act(async () => {
      expect(await freshA).toBe(true);
      expect(await staleA).toBe(false);
    });

    expect(prepareTerminalTabForFocus).toHaveBeenCalledWith(
      expect.objectContaining({ id: firstId }),
    );
    expect(focusMountedCard).toHaveBeenCalledWith(firstId);
  });

  it('leaves all identity and navigation state untouched and reports a missing card', async () => {
    useTerminalStore.setState({ selectedProjectPath: '/existing', focusedCardId: 'focused' });
    const {
      hook,
      mountCard,
      prepareTerminalTabForFocus,
      focusMountedCard,
      reportFailure,
    } = renderRecovery();

    await act(async () => { expect(await hook.result.current('missing')).toBe(false); });

    expect(useTerminalStore.getState()).toMatchObject({
      selectedProjectPath: '/existing', focusedCardId: 'focused', cards: [], archivedCards: [],
    });
    expect(mountCard).not.toHaveBeenCalled();
    expect(prepareTerminalTabForFocus).not.toHaveBeenCalled();
    expect(focusMountedCard).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(
      'missing',
      expect.objectContaining({ message: 'The terminal is no longer available.' }),
    );
  });

  it('reports one failure for joined callers', async () => {
    const cardId = createCard();
    const error = new Error('workspace unavailable');
    const { hook, reportFailure } = renderRecovery({
      prepareTerminalTabForFocus: vi.fn().mockResolvedValue({ outcome: 'failed', error }),
    });

    const first = hook.result.current(cardId);
    const second = hook.result.current(cardId);
    await act(async () => { await expect(first).resolves.toBe(false); });
    await expect(second).resolves.toBe(false);

    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(cardId, error);
  });

  it('also reports a rejected workspace preparation once', async () => {
    const cardId = createCard();
    const error = new Error('workspace rejected');
    const { hook, reportFailure } = renderRecovery({
      prepareTerminalTabForFocus: vi.fn().mockRejectedValue(error),
    });

    await act(async () => { expect(await hook.result.current(cardId)).toBe(false); });

    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(cardId, error);
  });
});
