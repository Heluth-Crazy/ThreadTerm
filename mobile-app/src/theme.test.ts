import { beforeEach, describe, expect, it } from 'vitest';
import {
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

  it('locks app mode while still updating terminal ANSI tokens from server theme messages', () => {
    const controller = new MobileThemeController(fallbackTheme, 'dark');
    const initialBackground = document.documentElement.style.getPropertyValue('--background');

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

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe(initialBackground);
    expect(document.documentElement.style.getPropertyValue('--terminal-bright-cyan')).toBe('#00ffff');
    expect(controller.getResolvedMode()).toBe('dark');
  });

  it('persists the local theme preference', () => {
    const controller = new MobileThemeController(fallbackTheme, 'auto');
    controller.setPreference('light');

    expect(window.localStorage.getItem(MOBILE_THEME_PREFERENCE_KEY)).toBe('light');
    expect(readMobileThemePreference()).toBe('light');
  });
});
