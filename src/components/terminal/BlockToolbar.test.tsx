import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BlockToolbar } from './BlockToolbar';
import type { Block } from '../../types/terminal';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

// Stub clipboard API
const writeText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText } },
  writable: true,
  configurable: true,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'blk-1',
    cardId: 'card-1',
    cwd: '/tmp',
    command: 'ls -la',
    startedAt: 0,
    bufferStart: 0,
    state: 'success',
    ...overrides,
  };
}

describe('BlockToolbar', () => {
  it('calls onCopyCommand when copy-command button is clicked', () => {
    const onCopyCommand = vi.fn();
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} onCopyCommand={onCopyCommand} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('block-copy-command'));
    expect(onCopyCommand).toHaveBeenCalledTimes(1);
  });

  it('calls onCopyOutput when copy-output button is clicked', () => {
    const onCopyOutput = vi.fn();
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} onCopyCommand={vi.fn()} onCopyOutput={onCopyOutput} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('block-copy-output'));
    expect(onCopyOutput).toHaveBeenCalledTimes(1);
  });

  it('calls onCopyBoth when copy-both button is clicked', () => {
    const onCopyBoth = vi.fn();
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={onCopyBoth} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('block-copy-both'));
    expect(onCopyBoth).toHaveBeenCalledTimes(1);
  });

  it('calls onRerun when re-run button is clicked', () => {
    const onRerun = vi.fn();
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={onRerun} onToggleCollapse={vi.fn()} onExplain={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('block-rerun'));
    expect(onRerun).toHaveBeenCalledWith('ls -la');
  });

  it('shows collapse icon when block is expanded', () => {
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={vi.fn()} />,
    );
    expect(screen.getByTestId('block-collapse-btn')).toBeTruthy();
    expect(screen.getByTestId('block-collapse-btn').getAttribute('data-collapsed')).toBe('false');
  });

  it('shows expand icon when block is collapsed', () => {
    render(
      <BlockToolbar block={makeBlock()} collapsed={true} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={vi.fn()} />,
    );
    expect(screen.getByTestId('block-collapse-btn').getAttribute('data-collapsed')).toBe('true');
  });

  it('calls onToggleCollapse when collapse button is clicked', () => {
    const onToggleCollapse = vi.fn();
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={onToggleCollapse} onExplain={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('block-collapse-btn'));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('calls onExplain when explain button is clicked', () => {
    const onExplain = vi.fn();
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={onExplain} />,
    );
    fireEvent.click(screen.getByTestId('block-explain'));
    expect(onExplain).toHaveBeenCalledTimes(1);
  });

  it('does not render re-run button for a running block', () => {
    render(
      <BlockToolbar block={makeBlock({ state: 'running' })} collapsed={false} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={vi.fn()} />,
    );
    expect(screen.queryByTestId('block-rerun')).toBeNull();
  });

  it('marks the re-run button data-pending when rerunPending is true', () => {
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} rerunPending={true} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={vi.fn()} />,
    );
    expect(screen.getByTestId('block-rerun').getAttribute('data-pending')).toBe('true');
  });

  it('does not mark data-pending when rerunPending is unset', () => {
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={vi.fn()} />,
    );
    expect(screen.getByTestId('block-rerun').getAttribute('data-pending')).toBe('false');
  });

  it('renders the bookmark button and reflects bookmarked=false', () => {
    const onToggleBookmark = vi.fn();
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} bookmarked={false} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={vi.fn()} onToggleBookmark={onToggleBookmark} />,
    );
    const btn = screen.getByTestId('block-bookmark');
    expect(btn.getAttribute('data-bookmarked')).toBe('false');
    fireEvent.click(btn);
    expect(onToggleBookmark).toHaveBeenCalledTimes(1);
  });

  it('reflects bookmarked=true via data attribute', () => {
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} bookmarked={true} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={vi.fn()} onToggleBookmark={vi.fn()} />,
    );
    expect(screen.getByTestId('block-bookmark').getAttribute('data-bookmarked')).toBe('true');
  });

  it('does not render bookmark button when onToggleBookmark is omitted', () => {
    render(
      <BlockToolbar block={makeBlock()} collapsed={false} onCopyCommand={vi.fn()} onCopyOutput={vi.fn()} onCopyBoth={vi.fn()} onRerun={vi.fn()} onToggleCollapse={vi.fn()} onExplain={vi.fn()} />,
    );
    expect(screen.queryByTestId('block-bookmark')).toBeNull();
  });
});
