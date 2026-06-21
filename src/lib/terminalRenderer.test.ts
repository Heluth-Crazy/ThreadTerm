import { describe, expect, it } from 'vitest';

import {
  normalizeWindowsNativeTerminalFlag,
  resolveTerminalRendererKind,
  WINDOWS_NATIVE_TERMINAL_CAPABILITIES_DRAFT,
  XTERM_TERMINAL_CAPABILITIES,
} from './terminalRenderer';

describe('normalizeWindowsNativeTerminalFlag', () => {
  it('defaults to off for missing or unknown values', () => {
    expect(normalizeWindowsNativeTerminalFlag(undefined)).toBe('off');
    expect(normalizeWindowsNativeTerminalFlag('')).toBe('off');
    expect(normalizeWindowsNativeTerminalFlag('disabled')).toBe('off');
  });

  it('accepts explicit enable values', () => {
    expect(normalizeWindowsNativeTerminalFlag('1')).toBe('on');
    expect(normalizeWindowsNativeTerminalFlag('true')).toBe('on');
    expect(normalizeWindowsNativeTerminalFlag('windows-native')).toBe('on');
  });

  it('preserves auto mode', () => {
    expect(normalizeWindowsNativeTerminalFlag('auto')).toBe('auto');
  });
});

describe('resolveTerminalRendererKind', () => {
  it('keeps xterm on non-Windows platforms even when the flag is enabled', () => {
    expect(
      resolveTerminalRendererKind({
        platform: 'macos',
        flagValue: 'on',
        nativeHostAvailable: true,
      }),
    ).toEqual({
      kind: 'xterm',
      flag: 'on',
      platform: 'macos',
      fallbackReason: 'non-windows-platform',
    });
  });

  it('keeps xterm on Windows when the feature flag is disabled', () => {
    expect(
      resolveTerminalRendererKind({
        platform: 'windows',
        flagValue: 'off',
        nativeHostAvailable: true,
      }),
    ).toEqual({
      kind: 'xterm',
      flag: 'off',
      platform: 'windows',
      fallbackReason: 'flag-disabled',
    });
  });

  it('falls back to xterm when the Windows native host is unavailable', () => {
    expect(
      resolveTerminalRendererKind({
        platform: 'windows',
        flagValue: 'on',
        nativeHostAvailable: false,
      }),
    ).toEqual({
      kind: 'xterm',
      flag: 'on',
      platform: 'windows',
      fallbackReason: 'native-host-unavailable',
    });
  });

  it('selects the Windows native renderer only when platform, flag, and host are ready', () => {
    expect(
      resolveTerminalRendererKind({
        platform: 'windows',
        flagValue: 'on',
        nativeHostAvailable: true,
      }),
    ).toEqual({
      kind: 'windows-native',
      flag: 'on',
      platform: 'windows',
    });
  });
});

describe('terminal renderer capabilities', () => {
  it('keeps xterm as the only full inspection provider today', () => {
    expect(XTERM_TERMINAL_CAPABILITIES.readScrollbackRange).toBe(true);
    expect(WINDOWS_NATIVE_TERMINAL_CAPABILITIES_DRAFT.readScrollbackRange).toBe(false);
  });

  it('documents native-only capabilities as draft until W2 proves them', () => {
    expect(WINDOWS_NATIVE_TERMINAL_CAPABILITIES_DRAFT.nativeIme).toBe(true);
    expect(WINDOWS_NATIVE_TERMINAL_CAPABILITIES_DRAFT.nativeSelection).toBe(true);
  });
});
