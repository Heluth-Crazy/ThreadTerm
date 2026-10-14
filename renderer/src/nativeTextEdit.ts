// Native textarea edit helper (design-inline-mentions.md §6.1). Every
// programmatic edit goes through the browser's own text insertion so it joins
// the native undo stack, and the React state is mirrored synchronously. When
// the native command is unavailable or fails, the caller's fallback keeps the
// edit (documented as not undoable).
export type NativeEditor = {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  focus: (options?: { preventScroll?: boolean }) => void;
  setSelectionRange: (start: number, end: number) => void;
};

export type NativeEditResult = { edited: boolean; fallback: boolean; caret: number };

export type NativeEditInput = {
  area: NativeEditor | null | undefined;
  start: number;
  end: number;
  insert: string;
  /** True while an IME composition owns the field; the edit is a no-op. */
  blocked?: boolean;
  /** The composer's writability guard; a false result is a no-op. */
  allowed: () => boolean;
  /** Mirrors the new DOM value into React state synchronously. */
  apply: (value: string) => void;
  /** `document.execCommand`, injectable for tests. */
  execCommand?: (command: 'insertText' | 'delete', showUI: boolean, value: string) => boolean;
  /** Schedules the caret restore (requestAnimationFrame by default). */
  schedule?: (run: () => void) => void;
};

function clampRange(text: string, start: number, end: number): { start: number; end: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { start: from, end: to };
}

/**
 * Replaces `[start, end)` with `insert` through the native command when
 * possible. Returns whether an edit happened and whether it used the fallback.
 */
export function applyNativeEdit(input: NativeEditInput): NativeEditResult {
  const { area, insert, apply, allowed } = input;
  if (!area || input.blocked || !allowed()) return { edited: false, fallback: false, caret: 0 };
  const { start, end } = clampRange(area.value, input.start, input.end);
  const schedule = input.schedule ?? (run => { globalThis.requestAnimationFrame?.(run); });
  area.focus({ preventScroll: true });
  area.setSelectionRange(start, end);
  const restore = (caret: number) => {
    schedule(() => {
      const field = area;
      field.focus({ preventScroll: true });
      field.setSelectionRange(caret, caret);
    });
  };
  if (input.execCommand) {
    let inserted = false;
    try { inserted = input.execCommand(insert ? 'insertText' : 'delete', false, insert); } catch { inserted = false; }
    if (inserted) {
      const caret = area.selectionStart ?? start + insert.length;
      apply(area.value);
      restore(caret);
      return { edited: true, fallback: false, caret };
    }
  }
  const next = `${area.value.slice(0, start)}${insert}${area.value.slice(end)}`;
  const caret = start + insert.length;
  apply(next);
  restore(caret);
  return { edited: true, fallback: true, caret };
}
