/**
 * Terminal clients whose input line takes ESC CR (what xterm sends for Alt+Enter) as "new line".
 * xterm.js sends plain CR for Shift+Enter, which these CLIs read as Enter and submit. Over ConPTY
 * only ESC CR reached both as a newline on the in-box ConPTY and on OpenConsole; LF, the kitty
 * encoding and win32-input records each failed or submitted somewhere (qa/terminal-repro.mjs,
 * 2026-10-03). Shells are not listed: PowerShell reads ESC as "revert the line".
 */
const NEWLINE_CLIENTS = new Set(['claude', 'codex']);

type KeyFacts = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'isComposing'>;

/** The bytes to send instead of xterm's own encoding of this key, or undefined to let xterm handle it. */
export function shiftEnterBytes(provider: string, event: KeyFacts): string | undefined {
  if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return undefined;
  return NEWLINE_CLIENTS.has(provider) ? '\x1b\r' : undefined;
}
