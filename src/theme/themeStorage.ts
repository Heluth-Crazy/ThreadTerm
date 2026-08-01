import { DEFAULT_THEME_PACK_ID } from './themePacks';
import type { StoredThemePreference, ThemeMode } from './themeTypes';
import {
  getPreloadedManagedStateItem,
  MANAGED_STATE_KEYS,
  preloadManagedState,
  writeManagedPreference,
} from '../lib/managedState';

export const THEME_MODE_STORAGE_KEY = 'themeMode';
export const THEME_PACK_STORAGE_KEY = 'themePackId';
export const LEGACY_THEME_STORAGE_KEY = 'theme';

export const DEFAULT_THEME_MODE: ThemeMode = 'system';

const THEME_MODES = new Set<ThemeMode>(['system', 'light', 'dark']);

export async function preloadThemePreference(): Promise<void> {
  await preloadManagedState([
    MANAGED_STATE_KEYS.themeMode,
    MANAGED_STATE_KEYS.themePack,
    MANAGED_STATE_KEYS.legacyTheme,
  ]);
}

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
    const storedMode = getPreloadedManagedStateItem(MANAGED_STATE_KEYS.themeMode);
    const legacyTheme = getPreloadedManagedStateItem(MANAGED_STATE_KEYS.legacyTheme);
    const storedPackId = getPreloadedManagedStateItem(MANAGED_STATE_KEYS.themePack);

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
    writeManagedPreference(MANAGED_STATE_KEYS.themeMode, preference.themeMode, {
      keepLegacyPaintCache: true,
    });
    writeManagedPreference(MANAGED_STATE_KEYS.themePack, preference.themePackId);
    if (preference.themeMode === 'light' || preference.themeMode === 'dark') {
      writeManagedPreference(MANAGED_STATE_KEYS.legacyTheme, preference.themeMode, {
        keepLegacyPaintCache: true,
      });
    } else {
      writeManagedPreference(MANAGED_STATE_KEYS.legacyTheme, null, {
        keepLegacyPaintCache: true,
      });
    }
  } catch {
    // localStorage may be unavailable in restricted webviews.
  }
}
