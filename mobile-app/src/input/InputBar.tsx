import { CornerDownLeft, Octagon, SendHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import type { MouseEvent, TouchEvent } from 'react';

interface InputBarProps {
  disabled: boolean;
  onSend: (data: string) => void;
}

export function InputBar({ disabled, onSend }: InputBarProps) {
  const [value, setValue] = useState('');
  const pendingInputBuffer = useRef('');
  const suppressNextClick = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const sendBuffered = (suffix = '\r') => {
    window.setTimeout(() => {
      const buffered = pendingInputBuffer.current || textareaRef.current?.value || value;
      onSend(buffered ? `${buffered}${suffix}` : suffix);
      pendingInputBuffer.current = '';
      setValue('');
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    }, 30);
  };

  const sendControl = (data: string) => {
    onSend(data);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const keepKeyboardFocus = (event: MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => {
    if (document.activeElement === textareaRef.current) {
      event.preventDefault();
    }
  };

  const runTouchAction = (event: TouchEvent<HTMLButtonElement>, action: () => void) => {
    keepKeyboardFocus(event);
    suppressNextClick.current = true;
    action();
  };

  const runClickAction = (action: () => void) => {
    if (suppressNextClick.current) {
      suppressNextClick.current = false;
      return;
    }
    action();
  };

  return (
    <footer className="input-bar safe-bottom">
      <textarea
        aria-label="Mobile terminal input"
        disabled={disabled}
        ref={textareaRef}
        value={value}
        rows={1}
        spellCheck={false}
        onChange={(event) => {
          pendingInputBuffer.current = event.target.value;
          setValue(event.target.value);
        }}
        onCompositionEnd={(event) => {
          pendingInputBuffer.current = event.currentTarget.value;
          setValue(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            if (event.nativeEvent.isComposing || event.keyCode === 229) {
              return;
            }
            event.preventDefault();
            sendBuffered('\r');
          }
        }}
      />
      <button
        className="input-action"
        type="button"
        disabled={disabled}
        onMouseDown={keepKeyboardFocus}
        onTouchStart={(event) => runTouchAction(event, () => sendBuffered('\r'))}
        onClick={() => runClickAction(() => sendBuffered('\r'))}
        aria-label="Enter"
      >
        <CornerDownLeft size={17} />
      </button>
      <button
        className="input-action"
        type="button"
        disabled={disabled}
        onMouseDown={keepKeyboardFocus}
        onTouchStart={(event) => runTouchAction(event, () => sendControl('\x1b'))}
        onClick={() => runClickAction(() => sendControl('\x1b'))}
        aria-label="Esc"
      >
        <SendHorizontal size={17} />
      </button>
      <button
        className="input-action danger"
        type="button"
        disabled={disabled}
        onMouseDown={keepKeyboardFocus}
        onTouchStart={(event) => runTouchAction(event, () => sendControl('\x03'))}
        onClick={() => runClickAction(() => sendControl('\x03'))}
        aria-label="Ctrl-C"
      >
        <Octagon size={17} />
      </button>
    </footer>
  );
}
