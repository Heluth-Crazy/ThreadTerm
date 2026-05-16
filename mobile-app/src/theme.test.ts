import { beforeEach, describe, expect, it } from 'vitest';
import { hexToHslToken } from '@shared/theme/applyTheme';
import {
  DARK_APP_TOKENS,
  LIGHT_APP_TOKENS,
  MOBILE_THEME_PREFERENCE_KEY,
  MobileThemeController,
  createFallbackThemeFromUrl,
  fallbackTheme,
  readMobileThemePreference,
} from './theme';

describe('mobile theme application', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('class');
    document.documentElement.removeAttribute('style');
    window.localStorage.clear();
  });

  it('creates a first-paint fallback from the four URL colors', () => {
    const theme = createFallbackThemeFromUrl(
      '?theme_bg=%23010203&theme_card=%23040506&theme_primary=%230a84ff&theme_fg=%23f8fafc',
    );

    expect(theme.app.background).toBe('#010203');
    expect(theme.app.card).toBe('#040506');
    expect(theme.app.primary).toBe('#0a84ff');
    expect(theme.terminal.foreground).toBe('#f8fafc');
  });

  it('follows server mode and app tokens while preference is auto', () => {
    const controller = new MobileThemeController(fallbackTheme, 'auto');
    controller.applyServerTheme({
      ...fallbackTheme,
      mode: 'light',
      app: {
        ...fallbackTheme.app,
        background: '#ffffff',
      },
    });

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('0 0% 100%');
    expect(controller.getResolvedMode()).toBe('light');
  });

  it('applies the built-in dark palette and locks it against server theme app tokens', () => {
    const controller = new MobileThemeController(fallbackTheme, 'dark');

    // Explicit dark must produce a real, visible dark palette (the bug was that
    // explicit preferences applied no app tokens at all).
    expect(document.documentElement.style.getPropertyValue('--background')).toBe(
      hexToHslToken(DARK_APP_TOKENS.background),
    );

    controller.applyServerTheme({
      ...fallbackTheme,
      mode: 'light',
      app: {
        ...fallbackTheme.app,
        background: '#ffffff',
      },
      terminal: {
        ...fallbackTheme.terminal,
        brightCyan: '#00ffff',
      },
    });

    // App palette stays locked to the explicit dark choice; only terminal
    // ANSI tokens still track the server theme.
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe(
      hexToHslToken(DARK_APP_TOKENS.background),
    );
    expect(document.documentElement.style.getPropertyValue('--terminal-bright-cyan')).toBe('#00ffff');
    expect(controller.getResolvedMode()).toBe('dark');
  });

  it('makes the appearance switch visible: dark and light apply different palettes', () => {
    const controller = new MobileThemeController(fallbackTheme, 'dark');
    const darkBackground = document.documentElement.style.getPropertyValue('--background');
    expect(darkBackground).toBe(hexToHslToken(DARK_APP_TOKENS.background));

    controller.setPreference('light');
    const lightBackground = document.documentElement.style.getPropertyValue('--background');

    expect(lightBackground).toBe(hexToHslToken(LIGHT_APP_TOKENS.background));
    expect(lightBackground).not.toBe(darkBackground);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(controller.getResolvedMode()).toBe('light');

    controller.setPreference('dark');
    expect(document.documentElement.style.getPropertyValue('--background')).toBe(darkBackground);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('persists the local theme preference', () => {
    const controller = new MobileThemeController(fallbackTheme, 'auto');
    controller.setPreference('light');

    expect(window.localStorage.getItem(MOBILE_THEME_PREFERENCE_KEY)).toBe('light');
    expect(readMobileThemePreference()).toBe('light');
  });
});
