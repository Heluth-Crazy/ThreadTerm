/**
 * xtermRegistry — small lookup of "the live xterm.js Terminal currently
 * driving this PTY id".
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

const terminals = new Map<string, Terminal>();

export function registerTerminal(ptyId: string, term: Terminal): void {
  if (!ptyId) return;
  terminals.set(ptyId, term);
}

export function unregisterTerminal(ptyId: string): void {
  if (!ptyId) return;
  terminals.delete(ptyId);
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
  const term = terminals.get(ptyId);
  if (!term) return 0;
  try {
    const buf = term.buffer.active;
    return buf.baseY + buf.cursorY;
  } catch {
    return 0;
  }
}
