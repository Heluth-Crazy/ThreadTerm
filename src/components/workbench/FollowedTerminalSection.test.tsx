import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import { FollowedTerminalSection } from './FollowedTerminalSection';

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

describe('FollowedTerminalSection vertical list', () => {
  beforeEach(() => {
    useTerminalStore.setState({ cards: [makeCard()] });
  });

  it('renders every card as a full-width row, scrolling inside the card body', () => {
    const callbacks = {
      onOpenTerminal: vi.fn(),
      onUnfollowCard: vi.fn(),
      onOpenRecall: vi.fn(),
    };
    render(
      <FollowedTerminalSection
        cards={[
          makeCard(),
          makeCard({ id: 'card-2', ptyId: 'card-2', projectName: 'Docs' }),
        ]}
        totalCount={2}
        now={NOW}
        queryActive={false}
        {...callbacks}
      />,
    );

    // The name also appears in the row subtitle via worktreeDisplayLabel,
    // so assert on the accessible open buttons instead of bare text.
    expect(
      screen.getByRole('button', { name: 'Open Repo terminal' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open Docs terminal' }),
    ).toBeInTheDocument();
    // No horizontal scroller / expand toggle anymore — the column list owns it.
    expect(screen.queryByTestId('followed-terminal-scroller')).toBeNull();
    expect(screen.queryByTitle('Show all')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open Docs terminal' }));
    expect(callbacks.onOpenTerminal).toHaveBeenCalledWith('card-2');
  });

  it('marks an archived row Closed, opens it through the callback, and disables rename', () => {
    const archivedCard: TerminalCard & { archivedAt: number } = {
      ...makeCard({ projectName: 'Closed terminal' }),
      archivedAt: NOW - 2_000,
    };
    const callbacks = renderSection(archivedCard);

    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByTitle('Double-click to rename')).toBeNull();

    fireEvent.doubleClick(screen.getAllByText('Closed terminal')[0]);
    expect(screen.queryByRole('textbox', { name: 'Rename card' })).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Open Closed terminal terminal' }),
    );
    expect(callbacks.onOpenTerminal).toHaveBeenCalledWith('card-1');
  });
});
