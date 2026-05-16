import { hexToHslToken } from '@shared/theme/applyTheme';
import { toXtermTheme } from '@shared/theme/xtermTheme';
import type {
  AppThemeTokens,
  ResolvedThemeMode,
  TerminalThemeTokens,
} from '@shared/theme/themeTypes';

export type MobileThemePreference = 'auto' | 'dark' | 'light';

export interface MobileThemeMessage {
  app: AppThemeTokens;
  terminal: TerminalThemeTokens;
  mode: ResolvedThemeMode;
}

export const MOBILE_THEME_PREFERENCE_KEY = 'threadterm.mobile.themePreference';

const APP_CSS_VARIABLES: Record<keyof AppThemeTokens, string> = {
  background: '--background',
  foreground: '--foreground',
  card: '--card',
  cardForeground: '--card-foreground',
  popover: '--popover',
  popoverForeground: '--popover-foreground',
  primary: '--primary',
  primaryForeground: '--primary-foreground',
  secondary: '--secondary',
  secondaryForeground: '--secondary-foreground',
  muted: '--muted',
  mutedForeground: '--muted-foreground',
  accent: '--accent',
  accentForeground: '--accent-foreground',
  destructive: '--destructive',
  destructiveForeground: '--destructive-foreground',
  border: '--border',
  input: '--input',
  ring: '--ring',
};

const TERMINAL_CSS_VARIABLES: Record<keyof TerminalThemeTokens, string> = {
  background: '--terminal-background',
  foreground: '--terminal-foreground',
  cursor: '--terminal-cursor',
  cursorAccent: '--terminal-cursor-accent',
  selection: '--terminal-selection',
  selectionForeground: '--terminal-selection-foreground',
  black: '--terminal-black',
  red: '--terminal-red',
  green: '--terminal-green',
  yellow: '--terminal-yellow',
  blue: '--terminal-blue',
  magenta: '--terminal-magenta',
  cyan: '--terminal-cyan',
  white: '--terminal-white',
  brightBlack: '--terminal-bright-black',
  brightRed: '--terminal-bright-red',
  brightGreen: '--terminal-bright-green',
  brightYellow: '--terminal-bright-yellow',
  brightBlue: '--terminal-bright-blue',
  brightMagenta: '--terminal-bright-magenta',
  brightCyan: '--terminal-bright-cyan',
  brightWhite: '--terminal-bright-white',
};

export const fallbackTheme: MobileThemeMessage = {
  mode: 'dark',
  app: {
    background: '#10151d',
    foreground: '#e8edf5',
    card: '#151b24',
    cardForeground: '#e8edf5',
    popover: '#151b24',
    popoverForeground: '#e8edf5',
    primary: '#4f8bd6',
    primaryForeground: '#f8fafc',
    secondary: '#263242',
    secondaryForeground: '#e8edf5',
    muted: '#202a38',
    mutedForeground: '#9aa7b7',
    accent: '#314154',
    accentForeground: '#e8edf5',
    destructive: '#ef4444',
    destructiveForeground: '#f8fafc',
    border: '#2d3948',
    input: '#263242',
    ring: '#4f8bd6',
  },
  terminal: {
    background: '#000000',
    foreground: '#f8fafc',
    cursor: '#f8fafc',
    cursorAccent: '#000000',
    selection: '#334155',
    selectionForeground: '#f8fafc',
    black: '#0f172a',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#eab308',
    blue: '#3b82f6',
    magenta: '#d946ef',
    cyan: '#06b6d4',
    white: '#e2e8f0',
    brightBlack: '#475569',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#facc15',
    brightBlue: '#60a5fa',
    brightMagenta: '#e879f9',
    brightCyan: '#22d3ee',
    brightWhite: '#f8fafc',
  },
};

export function readMobileThemePreference(storage: Storage | undefined = safeStorage()): MobileThemePreference {
  const stored = storage?.getItem(MOBILE_THEME_PREFERENCE_KEY);
  return stored === 'dark' || stored === 'light' || stored === 'auto' ? stored : 'auto';
}

export function saveMobileThemePreference(
  preference: MobileThemePreference,
  storage: Storage | undefined = safeStorage(),
) {
  storage?.setItem(MOBILE_THEME_PREFERENCE_KEY, preference);
}

export function createFallbackThemeFromUrl(search: string): MobileThemeMessage {
  const params = new URLSearchParams(search);
  const app = {
    ...fallbackTheme.app,
    background: validHex(params.get('theme_bg')) ?? fallbackTheme.app.background,
    card: validHex(params.get('theme_card')) ?? fallbackTheme.app.card,
    primary: validHex(params.get('theme_primary')) ?? fallbackTheme.app.primary,
    foreground: validHex(params.get('theme_fg')) ?? fallbackTheme.app.foreground,
  };

  return {
    ...fallbackTheme,
    app: {
      ...app,
      cardForeground: app.foreground,
      popover: app.card,
      popoverForeground: app.foreground,
      primaryForeground: readableForeground(app.primary),
    },
    terminal: {
      ...fallbackTheme.terminal,
      background: app.background,
      foreground: app.foreground,
      cursor: app.foreground,
      selection: app.primary,
    },
  };
}

export class MobileThemeController {
  private latest: MobileThemeMessage;
  private preference: MobileThemePreference;

  constructor(initial: MobileThemeMessage, preference = readMobileThemePreference()) {
    this.latest = initial;
    this.preference = preference;
    this.apply();
  }

  setPreference(preference: MobileThemePreference) {
    this.preference = preference;
    saveMobileThemePreference(preference);
    this.apply();
  }

  applyServerTheme(theme: MobileThemeMessage) {
    this.latest = theme;
    this.apply();
  }

  getPreference(): MobileThemePreference {
    return this.preference;
  }

  getResolvedMode(): ResolvedThemeMode {
    return this.preference === 'auto' ? this.latest.mode : this.preference;
  }

  getTerminalTheme() {
    return toXtermTheme(this.latest.terminal);
  }

  private apply() {
    if (typeof document === 'undefined') return;

    const mode = this.getResolvedMode();
    const root = document.documentElement;
    root.classList.toggle('dark', mode === 'dark');
    root.dataset.mobileThemeMode = this.preference;
    root.style.colorScheme = mode;

    if (this.preference === 'auto') {
      applyAppTokens(this.latest.app);
    }
    applyTerminalTokens(this.latest.terminal);

    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', this.latest.app.background);
    }
  }
}

export function applyAppTokens(tokens: AppThemeTokens) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [key, variable] of Object.entries(APP_CSS_VARIABLES) as Array<[keyof AppThemeTokens, string]>) {
    root.style.setProperty(variable, hexToHslToken(tokens[key]));
  }
}

export function applyTerminalTokens(tokens: TerminalThemeTokens) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [key, variable] of Object.entries(TERMINAL_CSS_VARIABLES) as Array<[
    keyof TerminalThemeTokens,
    string,
  ]>) {
    const value = tokens[key];
    if (value) root.style.setProperty(variable, value);
  }
}

function validHex(value: string | null): string | null {
  if (!value) return null;
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

function readableForeground(hex: string): string {
  const normalized = hex.replace('#', '');
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#10151d' : '#f8fafc';
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
