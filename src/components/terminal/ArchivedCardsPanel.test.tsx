import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { ArchivedCardsPanel } from './ArchivedCardsPanel';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    }),
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  useTerminalStore.setState({ cards: [], archivedCards: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ArchivedCardsPanel notification targeting', () => {
  it('scrolls, pulses, and reports the retained snapshot without restoring it', async () => {
    const cardId = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'codex',
    });
    useTerminalStore.getState().archiveCard(cardId);
    const card = useTerminalStore.getState().archivedCards[0];
    if (!card) throw new Error('expected archived card');

    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const target = { notificationId: 'notification-1', cardId };
    const onTargetLocated = vi.fn();

    render(
      <ArchivedCardsPanel
        projectName="repo"
        cards={[card]}
        onRestore={vi.fn()}
        onClose={vi.fn()}
        pendingTarget={target}
        onTargetLocated={onTargetLocated}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const item = screen.getByTestId(`archived-card-${cardId}`);
    expect(item).toHaveClass('animate-pulse');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' });
    expect(onTargetLocated).toHaveBeenCalledWith(target);
    expect(useTerminalStore.getState().cards).toHaveLength(0);
    expect(useTerminalStore.getState().archivedCards).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(item).not.toHaveClass('animate-pulse');
  });
});
