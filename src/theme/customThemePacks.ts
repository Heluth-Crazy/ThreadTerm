import type {
  AppThemeTokens,
  ResolvedThemeMode,
  TerminalThemeTokens,
  ThemeAttribution,
  ThemeAttributionKind,
  ThemeModeTokens,
  ThemePack,
} from './themeTypes';

export const CUSTOM_THEME_PACKS_STORAGE_KEY = 'threadterm-custom-theme-packs';

const CUSTOM_THEME_ID_PREFIX = 'custom:';
const MAX_CUSTOM_THEMES = 50;

const APP_TOKEN_KEYS: Array<keyof AppThemeTokens> = [
  'background',
  'foreground',
  'card',
  'cardForeground',
  'popover',
  'popoverForeground',
  'primary',
  'primaryForeground',
  'secondary',
  'secondaryForeground',
  'muted',
  'mutedForeground',
  'accent',
  'accentForeground',
  'destructive',
  'destructiveForeground',
  'border',
  'input',
  'ring',
];

const TERMINAL_TOKEN_KEYS: Array<keyof TerminalThemeTokens> = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selection',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

const MODE_KEYS: ResolvedThemeMode[] = ['light', 'dark'];
const ATTRIBUTION_KINDS = new Set<ThemeAttributionKind>(['original', 'based-on', 'inspired-by']);
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const HTTPS_URL_PATTERN = /^https:\/\//;

const READABILITY_PAIRS: Array<[
  string,
  (tokens: ThemeModeTokens) => string,
  (tokens: ThemeModeTokens) => string,
]> = [
  ['app background', (tokens) => tokens.app.foreground, (tokens) => tokens.app.background],
  ['card', (tokens) => tokens.app.cardForeground, (tokens) => tokens.app.card],
  ['popover', (tokens) => tokens.app.popoverForeground, (tokens) => tokens.app.popover],
  ['muted foreground', (tokens) => tokens.app.mutedForeground, (tokens) => tokens.app.background],
  ['primary', (tokens) => tokens.app.primaryForeground, (tokens) => tokens.app.primary],
  ['accent', (tokens) => tokens.app.accentForeground, (tokens) => tokens.app.accent],
  ['terminal', (tokens) => tokens.terminal.foreground, (tokens) => tokens.terminal.background],
];

export function parseCustomThemePack(json: string): ThemePack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Theme file is not valid JSON.');
  }

  const payload =
    isRecord(parsed) && isRecord(parsed.theme)
      ? parsed.theme
      : parsed;

  return normalizeCustomThemePack(payload);
}

export function getStoredCustomThemePacks(): ThemePack[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(CUSTOM_THEME_PACKS_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .slice(0, MAX_CUSTOM_THEMES)
      .map((item) => {
        try {
          return normalizeCustomThemePack(item);
        } catch {
          return null;
        }
      })
      .filter((pack): pack is ThemePack => Boolean(pack));
  } catch {
    return [];
  }
}

export function saveCustomThemePacks(packs: ThemePack[]) {
  if (typeof window === 'undefined') return;

  const portablePacks = packs
    .filter((pack) => pack.isCustom)
    .slice(0, MAX_CUSTOM_THEMES)
    .map(toPortableThemePack);

  try {
    window.localStorage.setItem(CUSTOM_THEME_PACKS_STORAGE_KEY, JSON.stringify(portablePacks));
  } catch {
    // localStorage may be unavailable in restricted webviews.
  }
}

export function toPortableThemePack(pack: ThemePack): ThemePack {
  return {
    id: stripCustomThemePrefix(pack.id),
    name: pack.name,
    description: pack.description,
    attribution: { ...pack.attribution },
    modes: pack.modes,
  };
}

export function stringifyThemePack(pack: ThemePack): string {
  return `${JSON.stringify(toPortableThemePack(pack), null, 2)}\n`;
}

export function getThemePackExportFilename(pack: ThemePack): string {
  const slug = slugify(stripCustomThemePrefix(pack.id) || pack.name || 'threadterm-theme');
  return `${slug || 'threadterm-theme'}.threadterm-theme.json`;
}

function normalizeCustomThemePack(value: unknown): ThemePack {
  if (!isRecord(value)) {
    throw new Error('Theme file must contain a theme object.');
  }

  const name = normalizeRequiredString(value.name, 'name');
  const id = normalizeCustomThemeId(value.id, name);
  const description = normalizeOptionalString(value.description) || 'Imported ThreadTerm theme.';
  const attribution = normalizeAttribution(value.attribution, name);
  const modes = normalizeModes(value.modes);
  const pack: ThemePack = {
    id,
    name,
    description,
    attribution,
    isCustom: true,
    modes,
  };

  validateReadability(pack);
  return pack;
}

function normalizeModes(value: unknown): ThemePack['modes'] {
  if (!isRecord(value)) {
    throw new Error('Theme file must define modes.light or modes.dark.');
  }

  const modes: ThemePack['modes'] = {};

  for (const mode of MODE_KEYS) {
    if (value[mode] === undefined) continue;
    modes[mode] = normalizeModeTokens(value[mode], mode);
  }

  if (!modes.light && !modes.dark) {
    throw new Error('Theme file must define at least one mode: light or dark.');
  }

  return modes;
}

function normalizeModeTokens(value: unknown, mode: ResolvedThemeMode): ThemeModeTokens {
  if (!isRecord(value)) {
    throw new Error(`Theme mode "${mode}" must be an object.`);
  }

  if (!isRecord(value.app)) {
    throw new Error(`Theme mode "${mode}" must define app tokens.`);
  }
  if (!isRecord(value.terminal)) {
    throw new Error(`Theme mode "${mode}" must define terminal tokens.`);
  }

  const app = pickHexTokens<AppThemeTokens>(value.app, APP_TOKEN_KEYS, `modes.${mode}.app`);
  const terminal = pickHexTokens<TerminalThemeTokens>(
    value.terminal,
    TERMINAL_TOKEN_KEYS,
    `modes.${mode}.terminal`,
  );
  const selectionForeground = value.terminal.selectionForeground;
  if (selectionForeground !== undefined) {
    terminal.selectionForeground = normalizeHexToken(selectionForeground, `modes.${mode}.terminal.selectionForeground`);
  }

  return { app, terminal };
}

function pickHexTokens<T>(
  value: Record<string, unknown>,
  keys: Array<keyof T>,
  path: string,
): T {
  const tokens: Record<string, string> = {};
  for (const key of keys) {
    tokens[String(key)] = normalizeHexToken(value[String(key)], `${path}.${String(key)}`);
  }
  return tokens as T;
}

function normalizeAttribution(value: unknown, themeName: string): ThemeAttribution {
  if (value === undefined) {
    return {
      kind: 'original',
      sourceName: themeName,
      sourceUrl: '',
    };
  }
  if (!isRecord(value)) {
    throw new Error('Theme attribution must be an object.');
  }

  const kind = ATTRIBUTION_KINDS.has(value.kind as ThemeAttributionKind)
    ? (value.kind as ThemeAttributionKind)
    : 'original';
  const sourceName = normalizeOptionalString(value.sourceName) || themeName;
  const sourceUrl = normalizeOptionalString(value.sourceUrl) || '';
  const licenseUrl = normalizeOptionalString(value.licenseUrl);

  if (kind !== 'original') {
    if (!HTTPS_URL_PATTERN.test(sourceUrl)) {
      throw new Error('Third-party themes must include attribution.sourceUrl using https://.');
    }
    if (!licenseUrl || !HTTPS_URL_PATTERN.test(licenseUrl)) {
      throw new Error('Third-party themes must include attribution.licenseUrl using https://.');
    }
  }

  return {
    kind,
    sourceName,
    sourceUrl,
    ...(licenseUrl ? { licenseUrl } : {}),
  };
}

function validateReadability(pack: ThemePack) {
  for (const [mode, tokens] of Object.entries(pack.modes)) {
    if (!tokens) continue;

    for (const [label, foreground, background] of READABILITY_PAIRS) {
      const ratio = contrastRatio(foreground(tokens), background(tokens));
      if (ratio < 4.5) {
        throw new Error(
          `Theme "${pack.name}" ${mode} ${label} contrast is ${ratio.toFixed(2)}. Minimum is 4.5.`,
        );
      }
    }
  }
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = hex
    .replace(/^#/, '')
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    );

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function normalizeCustomThemeId(value: unknown, name: string): string {
  const raw = normalizeOptionalString(value) || name;
  const withoutPrefix = stripCustomThemePrefix(raw);
  const slug = slugify(withoutPrefix) || slugify(name) || 'theme';
  return `${CUSTOM_THEME_ID_PREFIX}${slug.slice(0, 64)}`;
}

function stripCustomThemePrefix(value: string): string {
  return value.startsWith(CUSTOM_THEME_ID_PREFIX)
    ? value.slice(CUSTOM_THEME_ID_PREFIX.length)
    : value;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeRequiredString(value: unknown, path: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`Theme file must define ${path}.`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeHexToken(value: unknown, path: string): string {
  if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value)) {
    throw new Error(`${path} must be a #RRGGBB color.`);
  }
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
