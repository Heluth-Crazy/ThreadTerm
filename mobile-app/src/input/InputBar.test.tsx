import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InputBar } from './InputBar';

describe('InputBar', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('sends the buffered line once from a touch Enter action', () => {
    vi.useFakeTimers();
    const onSend = vi.fn();
    render(<InputBar disabled={false} onSend={onSend} />);

    const input = screen.getByLabelText('Mobile terminal input');
    fireEvent.change(input, { target: { value: 'hello from touch' } });
    input.focus();

    const enterButton = screen.getByRole('button', { name: 'Enter' });
    fireEvent.touchStart(enterButton);
    fireEvent.click(enterButton);

    expect(onSend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(31);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('hello from touch\r');
  });

  it('does not send while Enter is still composing IME text', () => {
    vi.useFakeTimers();
    const onSend = vi.fn();
    render(<InputBar disabled={false} onSend={onSend} />);

    const input = screen.getByLabelText('Mobile terminal input');
    fireEvent.change(input, { target: { value: 'ni' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 229 });
    fireEvent.compositionEnd(input, { data: '你', target: { value: '你' } });
    vi.advanceTimersByTime(31);

    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    vi.advanceTimersByTime(31);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('你\r');
  });

  it('does not duplicate control actions after touchstart', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} onSend={onSend} />);

    const input = screen.getByLabelText('Mobile terminal input');
    input.focus();

    const ctrlCButton = screen.getByRole('button', { name: 'Ctrl-C' });
    fireEvent.touchStart(ctrlCButton);
    fireEvent.click(ctrlCButton);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('\x03');
  });
});
