import { describe, expect, it } from 'vitest';
import { isTerminalConvertEolEnabled } from './terminalRenderFlags';

describe('terminal render flags', () => {
  it('preserves the current convertEol default', () => {
    expect(isTerminalConvertEolEnabled()).toBe(true);
  });

  it('allows an explicit environment override to win over storage', () => {
    expect(isTerminalConvertEolEnabled('false', 'true')).toBe(false);
    expect(isTerminalConvertEolEnabled('true', 'false')).toBe(true);
  });

  it('allows provider TUI callers to select a false fallback without changing the shell default', () => {
    expect(isTerminalConvertEolEnabled(undefined, undefined, false)).toBe(false);
    expect(isTerminalConvertEolEnabled('unknown', 'unknown', false)).toBe(false);
    expect(isTerminalConvertEolEnabled()).toBe(true);
  });

  it('ignores unknown values and falls back to storage/default', () => {
    expect(isTerminalConvertEolEnabled('unknown', 'false')).toBe(false);
    expect(isTerminalConvertEolEnabled('unknown', 'unknown')).toBe(true);
  });
});
