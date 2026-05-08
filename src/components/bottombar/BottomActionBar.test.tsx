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
    expect(screen.getByTestId('chip-bookmarks')).toBeInTheDocument();
    expect(screen.queryByTestId('chip-workflows')).toBeNull();
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
    expect(screen.queryByTestId('chip-workflows')).toBeNull();
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
    expect(document.activeElement).toBe(screen.getByTestId('chip-bookmarks'));
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
    const c = screen.getByTestId('chip-bookmarks');
    c.focus();
    fireEvent.keyDown(c, { key: 'Enter' });
    expect(onChipActivate).toHaveBeenCalledWith('bookmarks');
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

  it('renders bookmark badge when count > 0', () => {
    render(
      <BottomActionBarForContext
        cardCwd="/x"
        bridgeAvailable
        bookmarkCount={5}
        unreadNotifications={0}
        onChipActivate={vi.fn()}
      />,
    );
    const chip = screen.getByTestId('chip-bookmarks');
    expect(chip.textContent).toContain('5');
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
            { id: 'workflows', labelKey: 'bottomBar.workflows', iconKey: 'workflow' },
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
