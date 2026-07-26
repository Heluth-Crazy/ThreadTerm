import { describe, expect, it } from 'vitest';
import { hexToHslToken, resolveTheme } from './applyTheme';
import { DEFAULT_THEME_MODE } from './themeStorage';
import { themePacks } from './themePacks';
import type { ThemeModeTokens } from './themeTypes';

const ANSI_KEYS = [
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
] as const;

const READABILITY_PAIRS: Array<[
  string,
  (tokens: ThemeModeTokens) => string,
  (tokens: ThemeModeTokens) => string,
]> = [
  ['app background', (tokens) => tokens.app.foreground, (tokens) => tokens.app.background],
  ['card', (tokens) => tokens.app.cardForeground, (tokens) => tokens.app.card],
  ['popover', (tokens) => tokens.app.popoverForeground, (tokens) => tokens.app.popover],
  ['terminal', (tokens) => tokens.terminal.foreground, (tokens) => tokens.terminal.background],
];

describe('themePacks attribution', () => {
  it('keeps source metadata for every third-party theme', () => {
    const thirdPartyPacks = themePacks.filter((pack) => pack.attribution.kind !== 'original');

    expect(thirdPartyPacks.length).toBeGreaterThan(0);
    for (const pack of thirdPartyPacks) {
      expect(pack.attribution.sourceName).toBeTruthy();
      expect(pack.attribution.sourceUrl).toMatch(/^https:\/\//);
      expect(pack.attribution.licenseUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('themePacks tokens', () => {
  it('keeps a broad bundled theme selection', () => {
    expect(themePacks.length).toBeGreaterThanOrEqual(14);
  });

  it('registers Acme Mono as a bundled dark-only theme', () => {
    const acmeMono = themePacks.find((pack) => pack.id === 'acme-mono');

    expect(acmeMono).toBeDefined();
    expect(acmeMono?.name).toBe('Acme Mono');
    expect(acmeMono?.modes.dark).toBeDefined();
    expect(acmeMono?.modes.light).toBeUndefined();
  });

  it('registers Botanical as a bundled light-only theme', () => {
    const botanical = themePacks.find((pack) => pack.id === 'botanical');

    expect(botanical).toBeDefined();
    expect(botanical?.name).toBe('Botanical Garden');
    expect(botanical?.modes.light).toBeDefined();
    expect(botanical?.modes.dark).toBeUndefined();
  });

  it('defines a dark mode for every bundled pack except light-only Botanical', () => {
    for (const pack of themePacks) {
      if (pack.id === 'botanical') continue;
      expect(pack.modes.dark, pack.id).toBeDefined();
    }
  });

  it('defines a full ANSI terminal palette for every mode', () => {
    for (const pack of themePacks) {
      for (const [mode, tokens] of Object.entries(pack.modes)) {
        expect(tokens, `${pack.id}:${mode}`).toBeDefined();
        for (const key of ANSI_KEYS) {
          expect(tokens?.terminal[key], `${pack.id}:${mode}:${key}`).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
      }
    }
  });

  it('keeps primary UI and terminal text readable on Windows displays', () => {
    const failures: string[] = [];

    for (const pack of themePacks) {
      for (const [mode, tokens] of Object.entries(pack.modes)) {
        expect(tokens, `${pack.id}:${mode}`).toBeDefined();

        for (const [label, foreground, background] of READABILITY_PAIRS) {
          const ratio = contrastRatio(foreground(tokens!), background(tokens!));
          if (ratio < 4.5) {
            failures.push(`${pack.id}:${mode}:${label}=${ratio.toFixed(2)}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('resolves system preference to a usable pack', () => {
    const resolved = resolveTheme('missing-pack', DEFAULT_THEME_MODE);
    expect(resolved.pack.id).toBe('threadterm-default');
    expect(resolved.tokens.terminal.background).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('falls back to dark mode when Acme Mono is requested in light mode', () => {
    const resolved = resolveTheme('acme-mono', 'light');

    expect(resolved.pack.id).toBe('acme-mono');
    expect(resolved.mode).toBe('dark');
  });

  it('falls back to light mode when Botanical is requested in dark mode', () => {
    const resolved = resolveTheme('botanical', 'dark');

    expect(resolved.pack.id).toBe('botanical');
    expect(resolved.mode).toBe('light');
  });

  it('converts hex colors into Tailwind-compatible HSL tokens', () => {
    expect(hexToHslToken('#ffffff')).toBe('0 0% 100%');
    expect(hexToHslToken('#000000')).toBe('0 0% 0%');
  });
});

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
