/**
 * headlessPreview — maintain an invisible xterm.js Terminal per PTY session
 * purely to render a clean, wrap-aware text preview of what the user would
 * *see* on screen.
 *
 * Why this exists:
 *
 * Modern AI CLIs (Claude, Codex, etc.) are full-screen Ink/Ratatui-style
 * TUIs. They redraw the entire visible viewport on every frame using
 * ANSI cursor-movement sequences (e.g. `ESC[2J`, `ESC[<row>;<col>H`) and
 * partial line rewrites. If you just strip ANSI from the raw PTY byte
 * stream and split by `\n` (what the old `extractReplyPreview` did),
 * you end up with a garbled concatenation of every screen cell that was
 * ever written — the characters from different logical rows get fused,
 * and the user sees nonsense like "▌ ╭──╮ Helello╭──╮∙ WWorld".
 *
 * The only correct way to produce a readable preview is to RUN a
 * terminal emulator against the same byte stream and read the final
 * visible buffer. xterm.js exposes a fully scriptable `Terminal` class
 * that maintains the exact same buffer regardless of whether it's
 * attached to a DOM renderer — so we reuse it here in headless mode.
 *
 * Memory cost: ~60 KB per active card at scrollback=200, rows=40,
 * cols=120 (two bytes per cell). Fine for the 6-card pin limit.
 */
import { Terminal } from '@xterm/xterm';

const terms = new Map<string, Terminal>();

/** Default virtual size. Roughly matches a typical real-world terminal. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
/** Keep a couple of screens of scrollback so slow multi-line prints survive. */
const SCROLLBACK = 200;

function getOrCreate(id: string): Terminal {
  let t = terms.get(id);
  if (!t) {
    t = new Terminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: SCROLLBACK,
      // Never mounted to DOM, so renderer is irrelevant; we only read
      // from the buffer model.
      allowProposedApi: true,
      convertEol: false,
    });
    terms.set(id, t);
  }
  return t;
}

/**
 * Feed a chunk of PTY output into the headless emulator for `id`.
 * The caller provides an `onRendered` hook fired after the chunk is
 * fully parsed, so they can read the updated buffer synchronously.
 *
 * We intentionally do NOT return the preview synchronously: xterm's
 * `write` is asynchronous internally (it schedules parsing on a
 * microtask for large chunks), and reading the buffer before it
 * settles would give a stale frame.
 */
export function feedHeadless(
  id: string,
  data: string,
  onRendered: (preview: string) => void,
): void {
  const term = getOrCreate(id);
  term.write(data, () => {
    onRendered(readPreview(term));
  });
}

/**
 * Read the last N non-blank rows from the active buffer as a single
 * newline-joined string. Limits each row to ~240 visible chars to keep
 * the preview card layout honest.
 *
 * `tailRows` defaults to 32 — large enough to span both the bottom
 * input box (often 4–10 rows for Claude / Codex composers) and a
 * meaningful tail of the latest assistant reply *above* it. The
 * downstream `cardPreview` pass strips footer/hint noise and trims
 * to display size, so over-collecting here is cheap and keeps the
 * freshest reply from being clipped off the top.
 */
function readPreview(term: Terminal, tailRows = 32, maxCharsPerRow = 240): string {
  const buf = term.buffer.active;
  const total = buf.length;
  const out: string[] = [];
  // Scan upward from the cursor row (or the last row with content) and
  // collect non-blank lines until we have `tailRows` of them. This way
  // an agent that just cleared the screen and printed two new lines
  // produces a two-line preview, not six blank lines + two lines.
  //
  // Use `cursorY + baseY` as the authoritative "last written" row.
  const lastRow = Math.min(total - 1, buf.baseY + buf.cursorY);
  for (let y = lastRow; y >= 0 && out.length < tailRows; y--) {
    const line = buf.getLine(y);
    if (!line) continue;
    // `translateToString(true)` trims trailing whitespace per row.
    const text = line.translateToString(true);
    if (text.trim().length === 0) continue;
    out.push(text.length > maxCharsPerRow ? text.slice(0, maxCharsPerRow) + '…' : text);
  }
  return out.reverse().join('\n');
}

/**
 * Tear down the headless emulator for `id`. Call on session exit or
 * card removal. Safe to call on unknown ids.
 */
export function disposeHeadless(id: string): void {
  const t = terms.get(id);
  if (t) {
    try {
      t.dispose();
    } catch {
      /* xterm sometimes throws if dispose races with a pending write */
    }
    terms.delete(id);
  }
}

/** Clear all headless sessions. Used during bridge unmount / HMR. */
export function disposeAllHeadless(): void {
  for (const id of Array.from(terms.keys())) {
    disposeHeadless(id);
  }
}
