import { describe, expect, it } from 'vitest';
import {
  getThemePackExportFilename,
  parseCustomThemePack,
  stringifyThemePack,
} from './customThemePacks';

const appTokens = {
  background: '#ffffff',
  foreground: '#111827',
  card: '#f9fafb',
  cardForeground: '#111827',
  popover: '#ffffff',
  popoverForeground: '#111827',
  primary: '#2563eb',
  primaryForeground: '#ffffff',
  secondary: '#e5e7eb',
  secondaryForeground: '#111827',
  muted: '#f3f4f6',
  mutedForeground: '#4b5563',
  accent: '#dbeafe',
  accentForeground: '#1e3a8a',
  destructive: '#dc2626',
  destructiveForeground: '#ffffff',
  border: '#d1d5db',
  input: '#d1d5db',
  ring: '#2563eb',
};

const terminalTokens = {
  background: '#111827',
  foreground: '#f9fafb',
  cursor: '#f9fafb',
  cursorAccent: '#111827',
  selection: '#374151',
  selectionForeground: '#f9fafb',
  black: '#111827',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};

const validTheme = {
  id: 'My Imported Theme',
  name: 'My Imported Theme',
  description: 'A test theme.',
  attribution: {
    kind: 'original',
    sourceName: 'Local',
    sourceUrl: '',
  },
  modes: {
    light: {
      app: appTokens,
      terminal: terminalTokens,
    },
  },
};

describe('custom theme packs', () => {
  it('parses ThreadTerm theme JSON and isolates it under a custom id', () => {
    const pack = parseCustomThemePack(JSON.stringify(validTheme));

    expect(pack.id).toBe('custom:my-imported-theme');
    expect(pack.isCustom).toBe(true);
    expect(pack.modes.light?.app.background).toBe('#ffffff');
    expect(pack.modes.light?.terminal.brightWhite).toBe('#ffffff');
  });

  it('accepts wrapped theme payloads exported by future versions', () => {
    const pack = parseCustomThemePack(JSON.stringify({ schemaVersion: 1, theme: validTheme }));

    expect(pack.name).toBe('My Imported Theme');
  });

  it('rejects themes that do not meet basic readability contrast', () => {
    const lowContrastTheme = {
      ...validTheme,
      modes: {
        light: {
          app: {
            ...appTokens,
            foreground: '#f3f4f6',
          },
          terminal: terminalTokens,
        },
      },
    };

    expect(() => parseCustomThemePack(JSON.stringify(lowContrastTheme))).toThrow(/contrast/i);
  });

  it('exports portable JSON without the internal custom prefix', () => {
    const pack = parseCustomThemePack(JSON.stringify(validTheme));
    const exported = JSON.parse(stringifyThemePack(pack));

    expect(exported.id).toBe('my-imported-theme');
    expect(exported.isCustom).toBeUndefined();
    expect(getThemePackExportFilename(pack)).toBe('my-imported-theme.threadterm-theme.json');
  });
});
