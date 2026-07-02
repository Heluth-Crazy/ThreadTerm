import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BottomActionBar, BottomActionBarForContext } from './BottomActionBar';
import type { ChipId } from './chipRegistry';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && 'defaultValue' in opts) return opts.defaultValue as string;
        return key;
      },
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

afterEach(() => {
  cleanup();
});

describe('BottomActionBarForContext', () => {
  it('renders currently enabled chips for the current context', () => {
    const onChipActivate = vi.fn();
    render(
      <BottomActionBarForContext
        cardCwd="/home/u"
        bridgeAvailable
        bookmarkCount={1}
        unreadNotifications={0}
        onChipActivate={onChipActivate}
      />,
    );
    expect(screen.getByTestId('chip-notifications')).toBeInTheDocument();
    // Bookmarks feature is hidden behind `lib/featureFlags.ts`; the chip
    // must not render in the bottom action bar either.
    expect(screen.queryByTestId('chip-bookmarks')).toBeNull();
    expect(screen.queryByTestId('chip-file-explorer')).toBeNull();
    expect(screen.getByTestId('chip-rich-input')).toBeInTheDocument();
    expect(screen.getByTestId('chip-remote-control')).toBeInTheDocument();
  });

  it('omits hidden and gated chips when their context flags are false', () => {
    render(
      <BottomActionBarForContext
        cardCwd=""
        bridgeAvailable={false}
        bookmarkCount={0}
        unreadNotifications={0}
        onChipActivate={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('chip-file-explorer')).toBeNull();
    expect(screen.queryByTestId('chip-remote-control')).toBeNull();
  });

  it('ArrowRight moves focus to next chip', () => {
    render(
      <BottomActionBarForContext
        cardCwd="/x"
        bridgeAvailable
        bookmarkCount={0}
        unreadNotifications={0}
        onChipActivate={vi.fn()}
      />,
    );
    const first = screen.getByTestId('chip-notifications');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    // With the bookmarks and file-explorer chips hidden the next focusable
    // chip is rich-input.
    expect(document.activeElement).toBe(screen.getByTestId('chip-rich-input'));
  });

  it('ArrowLeft from notifications wraps to last chip', () => {
    render(
      <BottomActionBarForContext
        cardCwd="/x"
        bridgeAvailable
        bookmarkCount={0}
        unreadNotifications={0}
        onChipActivate={vi.fn()}
      />,
    );
    const first = screen.getByTestId('chip-notifications');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByTestId('chip-remote-control'));
  });

  it('Home jumps to first chip and End jumps to last', () => {
    render(
      <BottomActionBarForContext
        cardCwd="/x"
        bridgeAvailable
        bookmarkCount={0}
        unreadNotifications={0}
        onChipActivate={vi.fn()}
      />,
    );
    const middle = screen.getByTestId('chip-rich-input');
    middle.focus();
    fireEvent.keyDown(middle, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByTestId('chip-notifications'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('chip-remote-control'));
  });

  it('Enter activates the focused chip', () => {
    const onChipActivate = vi.fn<(id: ChipId) => void>();
    render(
      <BottomActionBarForContext
        cardCwd="/x"
        bridgeAvailable
        bookmarkCount={0}
        unreadNotifications={0}
        onChipActivate={onChipActivate}
      />,
    );
    // Bookmarks chip is hidden; pick a chip that is currently visible to
    // exercise the same keyboard activation path.
    const c = screen.getByTestId('chip-notifications');
    c.focus();
    fireEvent.keyDown(c, { key: 'Enter' });
    expect(onChipActivate).toHaveBeenCalledWith('notifications');
  });

  it('Space activates the focused chip', () => {
    const onChipActivate = vi.fn<(id: ChipId) => void>();
    render(
      <BottomActionBarForContext
        cardCwd="/x"
        bridgeAvailable
        bookmarkCount={0}
        unreadNotifications={0}
        onChipActivate={onChipActivate}
      />,
    );
    const c = screen.getByTestId('chip-rich-input');
    c.focus();
    fireEvent.keyDown(c, { key: ' ' });
    expect(onChipActivate).toHaveBeenCalledWith('rich-input');
  });

  it('does not surface the bookmarks chip even when a count is provided', () => {
    // While the bookmarks feature is hidden, the chip must stay out of the
    // bottom action bar regardless of any non-zero count plumbed in by the
    // host. Flipping the feature flag back on would restore both the chip
    // and the count-driven badge.
    render(
      <BottomActionBarForContext
        cardCwd="/x"
        bridgeAvailable
        bookmarkCount={5}
        unreadNotifications={0}
        onChipActivate={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('chip-bookmarks')).toBeNull();
  });

  it('collapses overflowing chips into a popover menu', async () => {
    const previousResizeObserver = globalThis.ResizeObserver;
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function clientWidth(this: HTMLElement) {
        return this.dataset.testid === 'bottom-action-bar' ? 100 : 0;
      });
    const offsetWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(function offsetWidth(this: HTMLElement) {
        return this.hasAttribute('data-chip-measure') ? 50 : 0;
      });
    globalThis.ResizeObserver = class ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback([], this);
      }
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;

    try {
      render(
        <BottomActionBar
          chips={[
            { id: 'notifications', labelKey: 'bottomBar.notifications', iconKey: 'bell' },
            { id: 'bookmarks', labelKey: 'bottomBar.bookmarks', iconKey: 'star' },
            { id: 'file-explorer', labelKey: 'bottomBar.fileExplorer', iconKey: 'folder' },
            { id: 'rich-input', labelKey: 'bottomBar.richInput', iconKey: 'message' },
            { id: 'remote-control', labelKey: 'bottomBar.remoteControl', iconKey: 'phone' },
          ]}
          onChipActivate={vi.fn()}
        />,
      );
      const overflow = await screen.findByTestId('chip-overflow');
      fireEvent.click(overflow);
      expect(screen.getByTestId('chip-overflow-menu')).toBeInTheDocument();
    } finally {
      globalThis.ResizeObserver = previousResizeObserver;
      clientWidthSpy.mockRestore();
      offsetWidthSpy.mockRestore();
    }
  });
});
