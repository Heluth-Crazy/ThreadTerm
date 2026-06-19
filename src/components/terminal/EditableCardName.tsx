/**
 * EditableCardName — inline-editable card title.
 *
 * Non-editing: renders the name as a truncating <span>.
 * Editing: renders an <input> that auto-focuses and selects all text.
 *   • Enter / blur  → onCommit(draft)
 *   • Escape        → onCancel (blur is suppressed so it doesn't also commit)
 *
 * All pointer / key events are stopped from bubbling so editing never reaches
 * the parent card's click-to-open / double-click handlers.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';

export interface EditableCardNameProps {
  value: string;
  editing: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
  ariaLabel?: string;
  className?: string;
}

const stop = (event: SyntheticEvent) => event.stopPropagation();

export function EditableCardName({
  value,
  editing,
  onCommit,
  onCancel,
  ariaLabel,
  className = 'truncate text-sm font-semibold',
}: EditableCardNameProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set on Escape so the subsequent blur doesn't commit the cancelled draft.
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    cancelledRef.current = false;
    setDraft(value);
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [editing, value]);

  if (!editing) {
    return <span className={className}>{value}</span>;
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      onCommit(draft);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelledRef.current = true;
      onCancel();
    }
  };

  const handleBlur = () => {
    if (cancelledRef.current) return;
    onCommit(draft);
  };

  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-primary/40 bg-background/80 px-1 py-0.5 text-sm font-semibold outline-none focus:border-primary"
    />
  );
}
