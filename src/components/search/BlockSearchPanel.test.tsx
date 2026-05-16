import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useTerminalStore } from '../../stores/terminalStore';
import { BlockSearchPanel } from './BlockSearchPanel';

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
  useTerminalStore.setState({ cards: [], blocks: {} });
});

function seedStore() {
  useTerminalStore.setState({
    cards: [
      // partial — we only access the few fields searchAcrossBlocks needs
      { id: 'c1', projectName: 'foo', projectPath: '/p/foo', terminalType: 'shell' } as never,
    ],
    blocks: {
      c1: [
        { id: 'b1', cardId: 'c1', cwd: '/p/foo', command: 'npm test', startedAt: 0, bufferStart: 0, state: 'success' },
        { id: 'b2', cardId: 'c1', cwd: '/p/foo', command: 'git status', startedAt: 0, bufferStart: 0, state: 'failed' },
      ],
    },
  });
}

describe('BlockSearchPanel', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<BlockSearchPanel open={false} onClose={vi.fn()} onJump={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the placeholder when open with no query', () => {
    render(<BlockSearchPanel open={true} onClose={vi.fn()} onJump={vi.fn()} />);
    expect(screen.getByTestId('block-search-input')).toBeTruthy();
    expect(screen.getByText('Search blocks')).toBeTruthy();
  });

  it('lists matches when the user types', async () => {
    seedStore();
    render(<BlockSearchPanel open={true} onClose={vi.fn()} onJump={vi.fn()} />);
    fireEvent.change(screen.getByTestId('block-search-input'), { target: { value: 'npm' } });
    await waitFor(() => {
      expect(screen.getByText('npm test')).toBeTruthy();
    });
  });

  it('calls onJump when a match is clicked', async () => {
    seedStore();
    const onJump = vi.fn();
    render(<BlockSearchPanel open={true} onClose={vi.fn()} onJump={onJump} />);
    fireEvent.change(screen.getByTestId('block-search-input'), { target: { value: 'git' } });
    await waitFor(() => screen.getByText('git status'));
    fireEvent.click(screen.getByText('git status'));
    expect(onJump).toHaveBeenCalledWith({ cardId: 'c1', blockId: 'b2' });
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<BlockSearchPanel open={true} onClose={onClose} onJump={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows empty-state when nothing matches', async () => {
    seedStore();
    render(<BlockSearchPanel open={true} onClose={vi.fn()} onJump={vi.fn()} />);
    fireEvent.change(screen.getByTestId('block-search-input'), { target: { value: 'zzz-nope' } });
    await waitFor(() => expect(screen.getByText('No matches found')).toBeTruthy());
  });

  it('clears query when re-opened (no persisted state)', () => {
    const { rerender } = render(<BlockSearchPanel open={true} onClose={vi.fn()} onJump={vi.fn()} />);
    fireEvent.change(screen.getByTestId('block-search-input'), { target: { value: 'foo' } });
    rerender(<BlockSearchPanel open={false} onClose={vi.fn()} onJump={vi.fn()} />);
    rerender(<BlockSearchPanel open={true} onClose={vi.fn()} onJump={vi.fn()} />);
    expect((screen.getByTestId('block-search-input') as HTMLInputElement).value).toBe('');
  });

  // ── Task 4 — timestamp display ──────────────────────────────────────────
  it('renders a HH:MM timestamp on each match row', async () => {
    useTerminalStore.setState({
      cards: [
        { id: 'c1', projectName: 'p', projectPath: '/p', terminalType: 'shell' } as never,
      ],
      blocks: {
        c1: [
          {
            id: 'b1',
            cardId: 'c1',
            cwd: '/p',
            command: 'go run',
            startedAt: 1_700_000_000_000,
            bufferStart: 0,
            state: 'success',
          },
        ],
      },
    });
    render(<BlockSearchPanel open={true} onClose={vi.fn()} onJump={vi.fn()} />);
    fireEvent.change(screen.getByTestId('block-search-input'), { target: { value: 'go' } });
    await waitFor(() => screen.getByText('go run'));
    const row = screen.getByText('go run').closest('li')!;
    expect(row.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  // ── Task 5 — matched output line ────────────────────────────────────────
  it('renders the matched output line under the command', async () => {
    useTerminalStore.setState({
      cards: [
        { id: 'c1', projectName: 'p', projectPath: '/p', terminalType: 'shell' } as never,
      ],
      blocks: {
        c1: [
          {
            id: 'b1',
            cardId: 'c1',
            cwd: '/p',
            command: 'ls',
            startedAt: 0,
            bufferStart: 0,
            state: 'success',
            output: 'README.md\npackage.json\nsrc/',
          },
        ],
      },
    });
    render(<BlockSearchPanel open={true} onClose={vi.fn()} onJump={vi.fn()} />);
    fireEvent.change(screen.getByTestId('block-search-input'), {
      target: { value: 'package' },
    });
    await waitFor(() => screen.getByText(/package\.json/));
    // Match line should appear and carry the ↳ marker.
    const row = screen.getByText('ls').closest('li')!;
    expect(row.textContent).toContain('package.json');
  });
});
