/**
 * xtermRegistry — small lookup of the live xterm.js Terminals currently
 * attached to each PTY id.
 *
 * Why this exists:
 * `Shell.jsx` owns the visible xterm; `TerminalEventBridge` owns the
 * `pty://block-*` event subscriptions and the Zustand store. Stage 3
 * needs the bridge to record `bufferStart` / `bufferEnd` (absolute
 * scrollback indices) the moment a block boundary is detected, but the
 * bridge has no reference to the visible terminal. This registry is
 * the narrow link.
 *
 * The plan deliberately picks **option A** (read `baseY + cursorY` at
 * event-arrival time, accept up to one row of imprecision and let
 * Stage 4 render with a +1 tolerance). The exact-emit-position route
 * (option B) would require correlating bytes-emitted in Rust with
 * byte-acks in JS and is out of Stage 3 scope.
 */
import type { Terminal } from '@xterm/xterm';

interface TerminalRegistration {
  term: Terminal;
  registeredAt: number;
  activeAt: number;
}

const terminals = new Map<string, TerminalRegistration[]>();
let registrationSeq = 0;

function nextRegistrationSeq(): number {
  registrationSeq += 1;
  return registrationSeq;
}

function activeRegistration(ptyId: string): TerminalRegistration | undefined {
  const list = terminals.get(ptyId);
  if (!list?.length) return undefined;
  return list.reduce((best, candidate) => {
    if (candidate.activeAt !== best.activeAt) {
      return candidate.activeAt > best.activeAt ? candidate : best;
    }
    return candidate.registeredAt > best.registeredAt ? candidate : best;
  });
}

export function registerTerminal(ptyId: string, term: Terminal): void {
  if (!ptyId) return;
  const list = terminals.get(ptyId) ?? [];
  const activeAt = nextRegistrationSeq();
  const existing = list.find((registration) => registration.term === term);
  if (existing) {
    existing.activeAt = activeAt;
    return;
  }
  list.push({
    term,
    registeredAt: activeAt,
    activeAt,
  });
  terminals.set(ptyId, list);
}

export function unregisterTerminal(ptyId: string, term?: Terminal): void {
  if (!ptyId) return;
  if (!term) {
    terminals.delete(ptyId);
    return;
  }
  const list = terminals.get(ptyId);
  if (!list) return;
  const next = list.filter((registration) => registration.term !== term);
  if (next.length === 0) {
    terminals.delete(ptyId);
    return;
  }
  terminals.set(ptyId, next);
}

export function claimTerminalActive(ptyId: string, term: Terminal): void {
  if (!ptyId) return;
  const list = terminals.get(ptyId);
  const registration = list?.find((candidate) => candidate.term === term);
  if (!registration) {
    registerTerminal(ptyId, term);
    return;
  }
  registration.activeAt = nextRegistrationSeq();
}

/**
 * Return the live Terminal instance for `ptyId`, or `undefined` if not mounted.
 *
 * Stage 4 uses this to call `registerMarker` / `registerDecoration` for
 * block boundary visualisation.
 */
export function getTerminal(ptyId: string): Terminal | undefined {
  return activeRegistration(ptyId)?.term;
}

/**
 * Read the absolute scrollback row index of the cursor for `ptyId`.
 *
 * Returns `0` when no Terminal is registered (e.g. a session is alive
 * in the backend but the visible Shell is currently unmounted, or the
 * card was just persisted from a previous app launch). Stage 4 should
 * treat `0` as "unknown — anchor to the top of the buffer" and tolerate
 * a 1-row offset elsewhere.
 */
export function getAbsoluteCursorRow(ptyId: string): number {
  const term = getTerminal(ptyId);
  if (!term) return 0;
  try {
    const buf = term.buffer.active;
    return buf.baseY + buf.cursorY;
  } catch {
    return 0;
  }
}

/**
 * Read the visible output in absolute rows `[startRow+1 .. endRow]` from
 * the live xterm buffer and return it joined by `\n`. Used by the Stage
 * 5.1 per-block output capture on `block-finished`.
 *
 * The first row is skipped because it holds the command echo itself —
 * the inspector/search care about the *command's output*, not the prompt.
 *
 * Returns an empty string when:
 *   • no terminal is registered (unmounted / cross-webview),
 *   • the range is empty or inverted,
 *   • xterm throws on `getLine` for any reason.
 *
 * `translateToString(true)` already trims trailing blank cells so the
 * returned lines are free of xterm's internal pad spaces. The caller is
 * responsible for further truncation (see MAX_BLOCK_OUTPUT_LENGTH).
 */
export function readBufferRange(
  ptyId: string,
  startRow: number,
  endRow: number,
): string {
  const term = getTerminal(ptyId);
  if (!term) return '';
  if (!Number.isFinite(startRow) || !Number.isFinite(endRow)) return '';
  if (endRow <= startRow) return '';
  try {
    const buf = term.buffer.active;
    const lines: string[] = [];
    // Skip the command echo on `startRow`; collect the inclusive end row.
    for (let row = startRow + 1; row <= endRow; row++) {
      const line = buf.getLine(row);
      if (line) lines.push(line.translateToString(true));
    }
    // Drop trailing empty rows so the preview doesn't end on blank padding.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  } catch {
    return '';
  }
}
