import { detectNativePlatform, type NativePlatform } from './nativeDesktop';

export type TerminalRendererKind = 'xterm' | 'windows-native';

export type WindowsNativeTerminalFlag = 'off' | 'on' | 'auto';

export type TerminalRendererFallbackReason =
  | 'flag-disabled'
  | 'non-windows-platform'
  | 'native-host-unavailable';

export interface TerminalCapabilities {
  nativeIme: boolean;
  nativeSelection: boolean;
  nativeAccessibility: boolean;
  readVisibleBuffer: boolean;
  readScrollbackRange: boolean;
  getCursorPosition: boolean;
  snapshotRestore: boolean;
}

export interface TerminalRendererResolution {
  kind: TerminalRendererKind;
  flag: WindowsNativeTerminalFlag;
  platform: NativePlatform;
  fallbackReason?: TerminalRendererFallbackReason;
}

export interface TerminalRendererResolutionOptions {
  platform?: NativePlatform;
  flagValue?: unknown;
  nativeHostAvailable?: boolean;
}

export interface TerminalAdapterGeometry {
  rows: number;
  cols: number;
  pixelWidth: number;
  pixelHeight: number;
  devicePixelRatio: number;
}

export interface TerminalThemeUpdate {
  background?: string;
  foreground?: string;
  cursor?: string;
  selectionBackground?: string;
}

export interface TerminalFontUpdate {
  family?: string;
  sizePx?: number;
  lineHeight?: number;
  weight?: string | number;
}

export interface TerminalAdapter {
  readonly kind: TerminalRendererKind;
  readonly capabilities: TerminalCapabilities;

  create(sessionId: string): Promise<void>;
  destroy(): Promise<void>;
  attach(container: HTMLElement): Promise<void>;
  detach(): Promise<void>;
  focus(): Promise<void>;

  writeOutput(data: string, seq?: number): Promise<void>;
  sendInput(data: string): Promise<void>;
  resize(geometry: TerminalAdapterGeometry): Promise<void>;

  copy(): Promise<void>;
  paste(text?: string): Promise<void>;
  hasSelection?(): Promise<boolean>;
  getSelectionText?(): Promise<string>;

  updateTheme(theme: TerminalThemeUpdate): Promise<void>;
  updateFont(font: TerminalFontUpdate): Promise<void>;
}

export interface TerminalInspectionProvider {
  readVisibleBuffer(): Promise<unknown>;
  readScrollbackRange(startRow: number, endRow: number): Promise<unknown>;
  getCursorPosition(): Promise<{ row: number; col: number }>;
  snapshot(): Promise<unknown>;
}

export const XTERM_TERMINAL_CAPABILITIES: TerminalCapabilities = {
  nativeIme: false,
  nativeSelection: false,
  nativeAccessibility: false,
  readVisibleBuffer: true,
  readScrollbackRange: true,
  getCursorPosition: true,
  snapshotRestore: true,
};

export const WINDOWS_NATIVE_TERMINAL_CAPABILITIES_DRAFT: TerminalCapabilities = {
  nativeIme: true,
  nativeSelection: true,
  nativeAccessibility: true,
  readVisibleBuffer: false,
  readScrollbackRange: false,
  getCursorPosition: false,
  snapshotRestore: true,
};

export function normalizeWindowsNativeTerminalFlag(flagValue: unknown): WindowsNativeTerminalFlag {
  if (typeof flagValue !== 'string') {
    return 'off';
  }

  const normalized = flagValue.trim().toLowerCase();
  if (!normalized) return 'off';

  if (['1', 'true', 'yes', 'on', 'enabled', 'native', 'windows-native'].includes(normalized)) {
    return 'on';
  }
  if (normalized === 'auto') {
    return 'auto';
  }
  return 'off';
}

export function resolveTerminalRendererKind(
  options: TerminalRendererResolutionOptions = {},
): TerminalRendererResolution {
  const platform = options.platform ?? detectNativePlatform();
  const flag = normalizeWindowsNativeTerminalFlag(options.flagValue);

  if (platform !== 'windows') {
    return {
      kind: 'xterm',
      flag,
      platform,
      fallbackReason: 'non-windows-platform',
    };
  }

  if (flag === 'off') {
    return {
      kind: 'xterm',
      flag,
      platform,
      fallbackReason: 'flag-disabled',
    };
  }

  if (options.nativeHostAvailable !== true) {
    return {
      kind: 'xterm',
      flag,
      platform,
      fallbackReason: 'native-host-unavailable',
    };
  }

  return {
    kind: 'windows-native',
    flag,
    platform,
  };
}

export function resolveDefaultTerminalRendererKind(): TerminalRendererResolution {
  return resolveTerminalRendererKind({
    flagValue: import.meta.env.VITE_THREADTERM_WINDOWS_NATIVE_TERMINAL,
    nativeHostAvailable: false,
  });
}
