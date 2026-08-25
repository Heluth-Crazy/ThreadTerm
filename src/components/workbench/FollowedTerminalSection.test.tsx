import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import { FollowedTerminalSection } from './FollowedTerminalSection';

/**
 * happy-dom performs no layout, so scroll metrics are always 0. Overriding
 * them on the scroller instance lets the edge-fade logic (audit P0 #1) be
 * exercised deterministically.
 */
function overrideScrollMetrics(
  el: HTMLElement,
  metrics: { scrollWidth: number; clientWidth: number; scrollLeft: number },
) {
  Object.defineProperty(el, 'scrollWidth', {
    configurable: true,
    value: metrics.scrollWidth,
  });
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    value: metrics.clientWidth,
  });
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    value: metrics.scrollLeft,
    writable: true,
  });
}

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (
        key: string,
        options?: Record<string, string | number | undefined> & { defaultValue?: string },
      ) => {
        let value = options?.defaultValue ?? key;
        for (const [name, replacement] of Object.entries(options ?? {})) {
          value = value.split(`{{${name}}}`).join(String(replacement));
        }
        return value;
      },
      i18n: { language: 'en' },
    }),
  };
});

const NOW = 1_000_000;

function makeCard(overrides: Partial<TerminalCard> = {}): TerminalCard {
  return {
    id: 'card-1',
    ptyId: 'card-1',
    projectPath: '/repo',
    projectName: 'Repo',
    terminalType: 'codex',
    status: 'running',
    createdAt: NOW - 10_000,
    lastActivity: NOW - 5_000,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 1,
    events: [],
    unread: false,
    ...overrides,
  };
}

function renderSection(card: TerminalCard) {
  const callbacks = {
    onOpenTerminal: vi.fn(),
    onUnfollowCard: vi.fn(),
    onOpenRecall: vi.fn(),
  };
  render(
    <FollowedTerminalSection
      cards={[card]}
      totalCount={1}
      now={NOW}
      queryActive={false}
      {...callbacks}
    />,
  );
  return callbacks;
}

describe('FollowedTerminalSection rename', () => {
  beforeEach(() => {
    useTerminalStore.setState({ cards: [makeCard()] });
  });

  it('renames the terminal via double-click without opening it', () => {
    const callbacks = renderSection(makeCard());

    fireEvent.doubleClick(screen.getByTitle('Double-click to rename'));

    const input = screen.getByRole('textbox', { name: 'Rename card' });
    fireEvent.change(input, { target: { value: 'Release Shell' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useTerminalStore.getState().cards[0].projectName).toBe('Release Shell');
    expect(callbacks.onOpenTerminal).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Rename card' })).toBeNull();
  });

  it('keeps a single click on the name from opening the terminal', () => {
    const callbacks = renderSection(makeCard());

    fireEvent.click(screen.getByTitle('Double-click to rename'));

    expect(callbacks.onOpenTerminal).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Rename card' })).toBeNull();
  });

  it('abandons the edit on Escape', () => {
    renderSection(makeCard());

    fireEvent.doubleClick(screen.getByTitle('Double-click to rename'));
    const input = screen.getByRole('textbox', { name: 'Rename card' });
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(useTerminalStore.getState().cards[0].projectName).toBe('Repo');
    expect(screen.queryByRole('textbox', { name: 'Rename card' })).toBeNull();
  });
});

describe('FollowedTerminalSection collapsed overflow fades', () => {
  beforeEach(() => {
    useTerminalStore.setState({ cards: [makeCard()] });
  });

  it('hints at clipped content with a right-edge fade while more cards remain', () => {
    renderSection(makeCard());

    const scroller = screen.getByTestId('followed-terminal-scroller');
    overrideScrollMetrics(scroller, {
      scrollWidth: 504,
      clientWidth: 300,
      scrollLeft: 0,
    });
    fireEvent.scroll(scroller);

    expect(screen.getByTestId('followed-scroll-fade-right')).toBeInTheDocument();
    expect(screen.queryByTestId('followed-scroll-fade-left')).toBeNull();
  });

  it('swaps the fade to the left edge once scrolled to the end', () => {
    renderSection(makeCard());

    const scroller = screen.getByTestId('followed-terminal-scroller');
    overrideScrollMetrics(scroller, {
      scrollWidth: 504,
      clientWidth: 300,
      scrollLeft: 204,
    });
    fireEvent.scroll(scroller);

    expect(screen.getByTestId('followed-scroll-fade-left')).toBeInTheDocument();
    expect(screen.queryByTestId('followed-scroll-fade-right')).toBeNull();
  });

  it('renders no fades when everything fits', () => {
    renderSection(makeCard());

    const scroller = screen.getByTestId('followed-terminal-scroller');
    overrideScrollMetrics(scroller, {
      scrollWidth: 248,
      clientWidth: 300,
      scrollLeft: 0,
    });
    fireEvent.scroll(scroller);

    expect(screen.queryByTestId('followed-scroll-fade-left')).toBeNull();
    expect(screen.queryByTestId('followed-scroll-fade-right')).toBeNull();
  });

  it('expanded mode wraps instead of scrolling and shows no fades', () => {
    const { rerender } = render(
      <FollowedTerminalSection
        cards={[makeCard(), makeCard({ id: 'card-2', ptyId: 'card-2' })]}
        totalCount={2}
        now={NOW}
        queryActive={false}
        onOpenTerminal={vi.fn()}
        onUnfollowCard={vi.fn()}
        onOpenRecall={vi.fn()}
      />,
    );

    // Expand via the header toggle.
    fireEvent.click(screen.getByTitle('Show all'));

    expect(screen.queryByTestId('followed-terminal-scroller')).toBeNull();
    expect(screen.queryByTestId('followed-scroll-fade-left')).toBeNull();
    expect(screen.queryByTestId('followed-scroll-fade-right')).toBeNull();
    expect(rerender).toBeDefined();
  });
});
