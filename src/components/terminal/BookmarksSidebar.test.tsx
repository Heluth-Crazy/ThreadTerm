import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useTerminalStore } from '../../stores/terminalStore';
import { BookmarksSidebar } from './BookmarksSidebar';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

afterEach(() => {
  cleanup();
  useTerminalStore.setState({ bookmarks: [], cards: [], selectedBlockId: {} });
});

describe('BookmarksSidebar', () => {
  it('renders the empty state when no bookmarks exist', () => {
    render(<BookmarksSidebar onJump={vi.fn()} />);
    expect(screen.getByText('No bookmarks yet')).toBeTruthy();
  });

  it('renders bookmark entries with command and cwd', () => {
    useTerminalStore.getState().addBookmark({
      blockId: 'b1',
      cardId: 'c1',
      command: 'npm test',
      cwd: '/proj',
    });
    render(<BookmarksSidebar onJump={vi.fn()} />);
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('/proj')).toBeTruthy();
  });

  it('calls onJump with cardId+blockId when an entry is clicked', () => {
    useTerminalStore.getState().addBookmark({
      blockId: 'b1',
      cardId: 'c1',
      command: 'ls',
      cwd: '/',
    });
    const onJump = vi.fn();
    render(<BookmarksSidebar onJump={onJump} />);
    fireEvent.click(screen.getByText('ls'));
    expect(onJump).toHaveBeenCalledWith({ cardId: 'c1', blockId: 'b1' });
  });

  it('removes a bookmark when the trash icon is clicked', () => {
    useTerminalStore.getState().addBookmark({
      blockId: 'b1',
      cardId: 'c1',
      command: 'ls',
      cwd: '/',
    });
    render(<BookmarksSidebar onJump={vi.fn()} />);
    fireEvent.click(screen.getByTestId('bookmark-remove-b1'));
    expect(useTerminalStore.getState().bookmarks).toHaveLength(0);
  });

  it('renders a close button when onClose is provided (with bookmarks)', () => {
    useTerminalStore.getState().addBookmark({
      blockId: 'b1',
      cardId: 'c1',
      command: 'ls',
      cwd: '/',
    });
    const onClose = vi.fn();
    render(<BookmarksSidebar onJump={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('bookmarks-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders a close button in the empty state when onClose is provided', () => {
    const onClose = vi.fn();
    render(<BookmarksSidebar onJump={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('bookmarks-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not render a close button when onClose is omitted', () => {
    render(<BookmarksSidebar onJump={vi.fn()} />);
    expect(screen.queryByTestId('bookmarks-close')).toBeNull();
  });
});
