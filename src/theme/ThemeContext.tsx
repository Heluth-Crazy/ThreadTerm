import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { applyResolvedTheme, resolveTheme } from './applyTheme';
import { themePacks, getThemePack } from './themePacks';
import {
  getStoredCustomThemePacks,
  saveCustomThemePacks,
  parseCustomThemePack,
  stringifyThemePack,
  getThemePackExportFilename,
  CUSTOM_THEME_PACKS_STORAGE_KEY,
} from './customThemePacks';
import {
  DEFAULT_THEME_MODE,
  getStoredThemePreference,
  saveThemePreference,
  THEME_MODE_STORAGE_KEY,
  THEME_PACK_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
} from './themeStorage';
import { toXtermTheme } from './xtermTheme';
import { isTauriEnv, mobileBridge } from '../lib/tauri-bridge';
import { emitSettingsChanged } from '../lib/settingsSync';
import type {
  StoredThemePreference,
  ThemeMode,
  ThemeModeTokens,
  ThemePack,
} from './themeTypes';

interface ThemeSettingsSnapshot {
  preference?: StoredThemePreference;
  customThemePacks?: ThemePack[];
}

interface ThemeContextValue {
  themeMode: ThemeMode;
  themePackId: string;
  resolvedMode: 'light' | 'dark';
  activeThemePack: ThemePack;
  activeThemeTokens: ThemeModeTokens;
  terminalTheme: ReturnType<typeof toXtermTheme>;
  themePacks: ThemePack[];
  isDarkMode: boolean;
  setThemeMode: (themeMode: ThemeMode) => void;
  setThemePackId: (themePackId: string) => void;
  importCustomThemePack: (json: string) => ThemePack;
  replaceCustomThemePacks: (packs: ThemePack[]) => void;
  setThemePreference: (nextPreference: Partial<StoredThemePreference>) => void;
  deleteCustomThemePack: (themePackId: string) => void;
  exportThemePack: (themePackId: string) => { filename: string; content: string };
  toggleDarkMode: () => void;
  applyThemeSettingsSnapshot: (snapshot?: ThemeSettingsSnapshot) => void;
  resetTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [preference, setPreference] = useState(() => getStoredThemePreference());
  const [customThemePacks, setCustomThemePacks] = useState(() => getStoredCustomThemePacks());
  const [systemTick, setSystemTick] = useState(0);

  const availableThemePacks = useMemo(
    () => [...themePacks, ...customThemePacks],
    [customThemePacks],
  );

  const resolvedTheme = useMemo(() => {
    void systemTick;
    return resolveTheme(preference.themePackId, preference.themeMode, availableThemePacks);
  }, [availableThemePacks, preference.themeMode, preference.themePackId, systemTick]);

  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
    saveThemePreference(preference);
  }, [preference, resolvedTheme]);

  useEffect(() => {
    if (!isTauriEnv()) return;

    void mobileBridge.broadcastTheme(resolvedTheme.tokens, resolvedTheme.mode).catch((error) => {
      console.debug('Failed to broadcast mobile bridge theme', error);
    });
  }, [resolvedTheme.mode, resolvedTheme.tokens]);

  useEffect(() => {
    if (preference.themePackId === resolvedTheme.pack.id) return;
    setPreference((current) => (
      current.themePackId === resolvedTheme.pack.id
        ? current
        : { ...current, themePackId: resolvedTheme.pack.id }
    ));
  }, [preference.themePackId, resolvedTheme.pack.id]);

  useEffect(() => {
    const storedPreference = getStoredThemePreference();
    const bootstrapTheme = resolveTheme(
      storedPreference.themePackId,
      storedPreference.themeMode,
      availableThemePacks,
    );
    applyResolvedTheme(bootstrapTheme);
    setPreference((current) => {
      if (current.themeMode === storedPreference.themeMode && current.themePackId === storedPreference.themePackId) {
        return current;
      }
      return storedPreference;
    });
    // We only want to align with pre-React bootstrap once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!window.matchMedia) return undefined;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (getStoredThemePreference().themeMode === 'system') {
        setSystemTick((value) => value + 1);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key !== THEME_MODE_STORAGE_KEY &&
        event.key !== THEME_PACK_STORAGE_KEY &&
        event.key !== LEGACY_THEME_STORAGE_KEY &&
        event.key !== CUSTOM_THEME_PACKS_STORAGE_KEY
      ) {
        return;
      }
      if (event.key === CUSTOM_THEME_PACKS_STORAGE_KEY) {
        setCustomThemePacks(getStoredCustomThemePacks());
      }
      setPreference(getStoredThemePreference());
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const emitThemeSettingsChanged = useCallback((
    nextPreference: StoredThemePreference,
    nextCustomThemePacks?: ThemePack[],
  ) => {
    void emitSettingsChanged({
      domain: 'theme',
      sourceWindow: 'settings',
      theme: {
        preference: nextPreference,
        customThemePacks: nextCustomThemePacks ?? getStoredCustomThemePacks(),
      },
    });
  }, []);

  const commitThemePreference = useCallback((
    nextPreference: StoredThemePreference,
    nextCustomThemePacks?: ThemePack[],
  ) => {
    saveThemePreference(nextPreference);
    setPreference(nextPreference);
    emitThemeSettingsChanged(nextPreference, nextCustomThemePacks);
  }, [emitThemeSettingsChanged]);

  const applyThemeSettingsSnapshot = useCallback((snapshot: ThemeSettingsSnapshot = {}) => {
    if (Array.isArray(snapshot.customThemePacks)) {
      setCustomThemePacks(snapshot.customThemePacks);
    } else {
      setCustomThemePacks(getStoredCustomThemePacks());
    }

    setPreference(snapshot.preference ?? getStoredThemePreference());
  }, []);

  const setThemeMode = useCallback((themeMode: ThemeMode) => {
    commitThemePreference({
      ...preference,
      themeMode,
    });
  }, [commitThemePreference, preference]);

  const setThemePackId = useCallback((themePackId: string) => {
    commitThemePreference({
      ...preference,
      themePackId: getThemePack(themePackId, availableThemePacks).id,
    });
  }, [availableThemePacks, commitThemePreference, preference]);

  const importCustomThemePack = useCallback((json: string) => {
    const pack = parseCustomThemePack(json);
    const nextCustomThemePacks = [
      pack,
      ...customThemePacks.filter((item) => item.id !== pack.id),
    ];
    const nextPreference = {
      ...preference,
      themePackId: pack.id,
    };

    saveCustomThemePacks(nextCustomThemePacks);
    setCustomThemePacks(nextCustomThemePacks);
    commitThemePreference(nextPreference, nextCustomThemePacks);
    return pack;
  }, [commitThemePreference, customThemePacks, preference]);

  const replaceCustomThemePacks = useCallback((packs: ThemePack[]) => {
    const next = packs.filter((pack) => pack?.isCustom);
    saveCustomThemePacks(next);
    setCustomThemePacks(next);
    emitThemeSettingsChanged(preference, next);
  }, [emitThemeSettingsChanged, preference]);

  const setThemePreference = useCallback((nextPreference: Partial<StoredThemePreference>) => {
    commitThemePreference({
      themeMode: nextPreference?.themeMode ?? preference.themeMode,
      themePackId: nextPreference?.themePackId ?? preference.themePackId,
    });
  }, [commitThemePreference, preference]);

  const deleteCustomThemePack = useCallback((themePackId: string) => {
    const nextCustomThemePacks = customThemePacks.filter((pack) => pack.id !== themePackId);
    const nextPreference = preference.themePackId === themePackId
      ? { ...preference, themePackId: getThemePack(null).id }
      : preference;

    saveCustomThemePacks(nextCustomThemePacks);
    setCustomThemePacks(nextCustomThemePacks);
    commitThemePreference(nextPreference, nextCustomThemePacks);
  }, [commitThemePreference, customThemePacks, preference]);

  const exportThemePack = useCallback((themePackId: string) => {
    const pack = getThemePack(themePackId, availableThemePacks);
    return {
      filename: getThemePackExportFilename(pack),
      content: stringifyThemePack(pack),
    };
  }, [availableThemePacks]);

  const toggleDarkMode = useCallback(() => {
    commitThemePreference({
      ...preference,
      themeMode: resolvedTheme.mode === 'dark' ? 'light' : 'dark',
    });
  }, [commitThemePreference, preference, resolvedTheme.mode]);

  const terminalTheme = useMemo(
    () => toXtermTheme(resolvedTheme.tokens.terminal),
    [resolvedTheme.tokens.terminal],
  );

  const value = useMemo(
    () => ({
      themeMode: preference.themeMode,
      themePackId: preference.themePackId,
      resolvedMode: resolvedTheme.mode,
      activeThemePack: resolvedTheme.pack,
      activeThemeTokens: resolvedTheme.tokens,
      terminalTheme,
      themePacks: availableThemePacks,
      isDarkMode: resolvedTheme.mode === 'dark',
      setThemeMode,
      setThemePackId,
      importCustomThemePack,
      replaceCustomThemePacks,
      setThemePreference,
      deleteCustomThemePack,
      exportThemePack,
      toggleDarkMode,
      applyThemeSettingsSnapshot,
      resetTheme: () =>
        commitThemePreference({
          themeMode: DEFAULT_THEME_MODE,
          themePackId: getThemePack(null).id,
        }),
    }),
    [
      preference.themeMode,
      preference.themePackId,
      resolvedTheme.mode,
      resolvedTheme.pack,
      resolvedTheme.tokens,
      terminalTheme,
      setThemeMode,
      setThemePackId,
      importCustomThemePack,
      replaceCustomThemePacks,
      setThemePreference,
      deleteCustomThemePack,
      exportThemePack,
      toggleDarkMode,
      applyThemeSettingsSnapshot,
      commitThemePreference,
      availableThemePacks,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};
