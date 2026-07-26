/**
 * shellBehavior — pure helpers extracted from Shell.tsx so the scroll-follow
 * decision, exit banner formatting, and reconnect backoff are unit-testable
 * without mounting xterm.
 */

export interface FollowableBuffer {
  /** 'normal' | 'alternate' — alternate screen = full-screen TUI app. */
  type: string;
  /** Topmost visible row of the viewport within the scrollback. */
  viewportY: number;
  /** Scroll position at which the viewport is at the bottom. */
  baseY: number;
}

/**
 * Whether new output should auto-scroll the viewport to the bottom.
 *
 * Rules (audit P0-1):
 *   • alternate screen (TUI apps like Claude/Codex/vim) → always follow;
 *     the app owns the whole viewport and there is no scrollback to read.
 *   • normal screen → follow only when the viewport already sits at the
 *     bottom. A user who scrolled up to read history must not be yanked
 *     back down by every incoming chunk.
 */
export function shouldFollowOutput(buffer: FollowableBuffer): boolean {
  if (buffer.type === 'alternate') return true;
  return buffer.viewportY >= buffer.baseY;
}

/**
 * ANSI-coloured one-line banner appended to the terminal when the PTY exits
 * (audit P1-2 — never clear the screen on exit; keep the error context).
 *
 * `label` is the already-translated human text, e.g. "process exited with
 * code 1". Colour encodes severity: green for 0, red for non-zero, plain
 * dim for null/undefined (deliberate kill — no verdict).
 */
export function formatExitBanner(code: number | null | undefined, label: string): string {
  const color =
    code === 0
      ? '\x1b[32m' // green
      : typeof code === 'number'
        ? '\x1b[31m' // red
        : '\x1b[2m'; // dim
  return `\r\n${color}── ${label} ──\x1b[0m\r\n`;
}

/** Exponential backoff used by Shell's PTY reconnect loop: 1s · 2^n, cap 30s. */
export function computeReconnectDelay(retryCount: number): number {
  return Math.min(1000 * Math.pow(2, retryCount), 30000);
}

/** Newline count of a chunk — drives the "N new lines below" indicator. */
export function countNewlines(data: string): number {
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data.charCodeAt(i) === 10) count++;
  }
  return count;
}
