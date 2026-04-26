import { getStoredCustomThemePacks } from './customThemePacks';
import { getThemePack, themePacks } from './themePacks';
import { getStoredThemePreference } from './themeStorage';
import type {
  AppThemeTokens,
  ResolvedTheme,
  ResolvedThemeMode,
  ThemePack,
  TerminalThemeTokens,
  ThemeMode,
} from './themeTypes';

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

const TERMINAL_CSS_VARIABLES: Partial<Record<keyof TerminalThemeTokens, string>> = {
  background: '--terminal-background',
  foreground: '--terminal-foreground',
  cursor: '--terminal-cursor',
  cursorAccent: '--terminal-cursor-accent',
  selection: '--terminal-selection',
  selectionForeground: '--terminal-selection-foreground',
};

export function getSystemThemeMode(): ResolvedThemeMode {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function resolveThemeMode(themeMode: ThemeMode): ResolvedThemeMode {
  return themeMode === 'system' ? getSystemThemeMode() : themeMode;
}

export function resolveTheme(
  themePackId: string,
  themeMode: ThemeMode,
  availableThemePacks?: ThemePack[],
): ResolvedTheme {
  const pack = getThemePack(themePackId, availableThemePacks);
  const preferredMode = resolveThemeMode(themeMode);
  const mode = pack.modes[preferredMode]
    ? preferredMode
    : pack.modes.dark
      ? 'dark'
      : 'light';
  const tokens = pack.modes[mode];

  if (!tokens) {
    throw new Error(`Theme pack "${pack.id}" does not define any usable mode`);
  }

  return { pack, mode, tokens };
}

export function applyResolvedTheme(resolved: ResolvedTheme) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  root.classList.toggle('dark', resolved.mode === 'dark');
  root.dataset.themePack = resolved.pack.id;
  root.style.colorScheme = resolved.mode;

  for (const [key, cssVariable] of Object.entries(APP_CSS_VARIABLES) as Array<[keyof AppThemeTokens, string]>) {
    root.style.setProperty(cssVariable, hexToHslToken(resolved.tokens.app[key]));
  }

  for (
    const [key, cssVariable] of Object.entries(TERMINAL_CSS_VARIABLES) as Array<[
      keyof TerminalThemeTokens,
      string,
    ]>
  ) {
    const value = resolved.tokens.terminal[key];
    if (value) root.style.setProperty(cssVariable, value);
  }

  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) {
    themeColorMeta.setAttribute('content', resolved.tokens.app.background);
  }
}

export function applySavedTheme(availableThemePacks?: ThemePack[]): ResolvedTheme {
  const preference = getStoredThemePreference();
  const resolved = resolveTheme(
    preference.themePackId,
    preference.themeMode,
    availableThemePacks ?? [...themePacks, ...getStoredCustomThemePacks()],
  );
  applyResolvedTheme(resolved);
  return resolved;
}

export function hexToHslToken(hex: string): string {
  const normalized = normalizeHex(hex);
  const r = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const g = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const b = Number.parseInt(normalized.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return `${Math.round(h * 360)} ${roundPercent(s)}% ${roundPercent(l)}%`;
}

function normalizeHex(hex: string): string {
  const value = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(value)) {
    return value
      .split('')
      .map((part) => part + part)
      .join('')
      .toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(value)) {
    return value.toLowerCase();
  }
  throw new Error(`Invalid hex color "${hex}"`);
}

function roundPercent(value: number): number {
  return Math.round(value * 1000) / 10;
}
