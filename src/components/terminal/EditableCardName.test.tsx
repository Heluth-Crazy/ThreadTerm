import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EditableCardName } from './EditableCardName';

describe('EditableCardName', () => {
  it('renders a static label when not editing', () => {
    render(<EditableCardName value="foo" editing={false} onCommit={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('foo')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('commits the draft on Enter', () => {
    const onCommit = vi.fn();
    render(<EditableCardName value="foo" editing onCommit={onCommit} onCancel={() => {}} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'bar' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('bar');
  });

  it('commits the draft on blur', () => {
    const onCommit = vi.fn();
    render(<EditableCardName value="foo" editing onCommit={onCommit} onCancel={() => {}} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'bar' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('bar');
  });

  it('cancels on Escape without committing', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(<EditableCardName value="foo" editing onCommit={onCommit} onCancel={onCancel} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'bar' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit on the blur that follows Escape', () => {
    const onCommit = vi.fn();
    render(<EditableCardName value="foo" editing onCommit={onCommit} onCancel={() => {}} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'bar' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
