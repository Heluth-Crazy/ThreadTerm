/** Runtime switches for terminal rendering experiments.
 *
 * The generic default preserves the shell renderer contract. Provider TUI
 * callers may pass `false` as the fallback because their VT stream positions
 * rows explicitly. A localStorage value or Vite env override lets Windows
 * builds A/B `convertEol` without changing PTY bytes, snapshot sequencing, or
 * ACK behavior.
 */

export const TERMINAL_CONVERT_EOL_FLAG_KEY = 'threadterm.terminalConvertEol';

export function isTerminalConvertEolEnabled(
  envValue?: string | null,
  storageValue?: string | null,
  defaultValue = true,
): boolean {
  return readFlag(envValue) ?? readFlag(storageValue) ?? defaultValue;
}

export function readTerminalConvertEolEnabled(defaultValue = true): boolean {
  const envValue =
    typeof import.meta !== 'undefined'
      ? (import.meta.env?.VITE_THREADTERM_TERMINAL_CONVERT_EOL as string | undefined)
      : undefined;
  let storageValue: string | null | undefined;
  try {
    if (typeof localStorage !== 'undefined') {
      storageValue = localStorage.getItem(TERMINAL_CONVERT_EOL_FLAG_KEY);
    }
  } catch {
    storageValue = undefined;
  }
  return isTerminalConvertEolEnabled(envValue, storageValue, defaultValue);
}

function readFlag(value: string | null | undefined): boolean | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(normalized)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(normalized)) return true;
  return null;
}
