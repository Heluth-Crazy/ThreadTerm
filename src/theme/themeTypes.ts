export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedThemeMode = 'light' | 'dark';

export type ThemeAttributionKind = 'original' | 'based-on' | 'inspired-by';

export interface ThemeAttribution {
  kind: ThemeAttributionKind;
  sourceName: string;
  sourceUrl: string;
  licenseUrl?: string;
}

export interface AppThemeTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

export interface TerminalThemeTokens {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeModeTokens {
  app: AppThemeTokens;
  terminal: TerminalThemeTokens;
}

export interface ThemePack {
  id: string;
  name: string;
  description: string;
  attribution: ThemeAttribution;
  isCustom?: boolean;
  modes: Partial<Record<ResolvedThemeMode, ThemeModeTokens>>;
}

export interface StoredThemePreference {
  themeMode: ThemeMode;
  themePackId: string;
}

export interface ResolvedTheme {
  pack: ThemePack;
  mode: ResolvedThemeMode;
  tokens: ThemeModeTokens;
}
