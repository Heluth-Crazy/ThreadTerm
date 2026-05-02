import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommandPalette } from './CommandPalette';
import type { CommandEntry } from './commandRegistry';

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

afterEach(() => cleanup());

function makeEntries(): CommandEntry[] {
  return [
    {
      id: 'a',
      label: 'Card foo',
      searchText: 'card foo',
      group: 'jump-card',
      run: vi.fn(),
    },
    {
      id: 'b',
      label: 'Block npm test',
      searchText: 'block npm test',
      group: 'jump-block',
      run: vi.fn(),
    },
  ];
}

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <CommandPalette open={false} entries={makeEntries()} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('lists entries when open', () => {
    render(<CommandPalette open={true} entries={makeEntries()} onClose={vi.fn()} />);
    expect(screen.getByText('Card foo')).toBeTruthy();
    expect(screen.getByText('Block npm test')).toBeTruthy();
  });

  it('filters entries as the user types', () => {
    render(<CommandPalette open={true} entries={makeEntries()} onClose={vi.fn()} />);
    const input = screen.getByTestId('palette-input');
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('Card foo')).toBeTruthy();
    expect(screen.queryByText('Block npm test')).toBeNull();
  });

  it('runs the first entry on Enter and closes', () => {
    const list = makeEntries();
    const onClose = vi.fn();
    render(<CommandPalette open={true} entries={list} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(list[0].run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves selection with ArrowDown', () => {
    render(<CommandPalette open={true} entries={makeEntries()} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
  });

  it('wraps selection with ArrowUp from index 0', () => {
    render(<CommandPalette open={true} entries={makeEntries()} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    const options = screen.getAllByRole('option');
    expect(options[options.length - 1].getAttribute('aria-selected')).toBe('true');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} entries={makeEntries()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('runs entry on click', () => {
    const list = makeEntries();
    const onClose = vi.fn();
    render(<CommandPalette open={true} entries={list} onClose={onClose} />);
    fireEvent.click(screen.getByText('Block npm test'));
    expect(list[1].run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when no matches', () => {
    render(<CommandPalette open={true} entries={makeEntries()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('palette-input'), { target: { value: 'zzzzz' } });
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('restores focus to the previously focused element when closed', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'host';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { rerender } = render(
      <CommandPalette open={true} entries={makeEntries()} onClose={vi.fn()} />,
    );
    // input grabs focus on open
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).not.toBe(trigger);

    rerender(<CommandPalette open={false} entries={makeEntries()} onClose={vi.fn()} />);
    // restore is queued in rAF
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });
});
