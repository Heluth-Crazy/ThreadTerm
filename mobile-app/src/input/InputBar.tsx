import { CornerDownLeft, Octagon } from 'lucide-react';
import { useRef, useState } from 'react';
import type { MouseEvent, ReactNode, TouchEvent } from 'react';

interface InputBarProps {
  disabled: boolean;
  onSend: (data: string) => void;
}

// Extra control keys exposed as a horizontally-scrollable strip above the main
// input row. These let a phone drive Claude/Codex TUI menus (arrow keys, Tab)
// and send EOF (Ctrl-D) without a hardware keyboard.
const CONTROL_KEYS: { label: string; data: string; ariaLabel: string }[] = [
  { label: '↑', data: '\x1b[A', ariaLabel: 'Arrow up' },
  { label: '↓', data: '\x1b[B', ariaLabel: 'Arrow down' },
  { label: '←', data: '\x1b[D', ariaLabel: 'Arrow left' },
  { label: '→', data: '\x1b[C', ariaLabel: 'Arrow right' },
  { label: 'Tab', data: '\t', ariaLabel: 'Tab' },
  { label: 'Ctrl-D', data: '\x04', ariaLabel: 'Ctrl-D' },
];

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

  // Shared wiring for any momentary control button: keep keyboard focus, run
  // the action once on touch, and de-duplicate the synthetic click.
  const controlButtonHandlers = (action: () => void) => ({
    onMouseDown: keepKeyboardFocus,
    onTouchStart: (event: TouchEvent<HTMLButtonElement>) => runTouchAction(event, action),
    onClick: () => runClickAction(action),
  });

  const renderControlButton = (
    key: string,
    ariaLabel: string,
    className: string,
    action: () => void,
    children: ReactNode,
  ) => (
    <button
      key={key}
      className={className}
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      {...controlButtonHandlers(action)}
    >
      {children}
    </button>
  );

  return (
    <footer className="input-bar-shell safe-bottom">
      <div className="input-key-strip" role="group" aria-label="Terminal control keys">
        {CONTROL_KEYS.map((control) =>
          renderControlButton(
            control.ariaLabel,
            control.ariaLabel,
            'input-key',
            () => sendControl(control.data),
            <span aria-hidden="true">{control.label}</span>,
          ),
        )}
      </div>
      <div className="input-bar">
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
        {renderControlButton(
          'Enter',
          'Enter',
          'input-action',
          () => sendBuffered('\r'),
          <CornerDownLeft size={17} />,
        )}
        {renderControlButton(
          'Esc',
          'Esc',
          'input-action input-action-esc',
          () => sendControl('\x1b'),
          <span aria-hidden="true">Esc</span>,
        )}
        {renderControlButton(
          'Ctrl-C',
          'Ctrl-C',
          'input-action danger',
          () => sendControl('\x03'),
          <Octagon size={17} />,
        )}
      </div>
    </footer>
  );
}
