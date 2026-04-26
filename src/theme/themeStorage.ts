import { DEFAULT_THEME_PACK_ID } from './themePacks';
import type { StoredThemePreference, ThemeMode } from './themeTypes';

export const THEME_MODE_STORAGE_KEY = 'themeMode';
export const THEME_PACK_STORAGE_KEY = 'themePackId';
export const LEGACY_THEME_STORAGE_KEY = 'theme';

export const DEFAULT_THEME_MODE: ThemeMode = 'system';

const THEME_MODES = new Set<ThemeMode>(['system', 'light', 'dark']);

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && THEME_MODES.has(value as ThemeMode);
}

export function getStoredThemePreference(): StoredThemePreference {
  if (typeof window === 'undefined') {
    return {
      themeMode: DEFAULT_THEME_MODE,
      themePackId: DEFAULT_THEME_PACK_ID,
    };
  }

  let themeMode: ThemeMode = DEFAULT_THEME_MODE;
  let themePackId = DEFAULT_THEME_PACK_ID;

  try {
    const storedMode = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    const legacyTheme = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    const storedPackId = window.localStorage.getItem(THEME_PACK_STORAGE_KEY);

    if (isThemeMode(storedMode)) {
      themeMode = storedMode;
    } else if (legacyTheme === 'light' || legacyTheme === 'dark') {
      themeMode = legacyTheme;
    }

    if (storedPackId) {
      themePackId = storedPackId;
    }
  } catch {
    themeMode = DEFAULT_THEME_MODE;
    themePackId = DEFAULT_THEME_PACK_ID;
  }

  return { themeMode, themePackId };
}

export function saveThemePreference(preference: StoredThemePreference) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, preference.themeMode);
    window.localStorage.setItem(THEME_PACK_STORAGE_KEY, preference.themePackId);
    if (preference.themeMode === 'light' || preference.themeMode === 'dark') {
      window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, preference.themeMode);
    } else {
      window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
    }
  } catch {
    // localStorage may be unavailable in restricted webviews.
  }
}
