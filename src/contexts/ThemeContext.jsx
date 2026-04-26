import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { applyResolvedTheme, resolveTheme } from '../theme/applyTheme';
import { themePacks, getThemePack } from '../theme/themePacks';
import {
  getStoredCustomThemePacks,
  saveCustomThemePacks,
  parseCustomThemePack,
  stringifyThemePack,
  getThemePackExportFilename,
  CUSTOM_THEME_PACKS_STORAGE_KEY,
} from '../theme/customThemePacks';
import {
  DEFAULT_THEME_MODE,
  getStoredThemePreference,
  saveThemePreference,
  THEME_MODE_STORAGE_KEY,
  THEME_PACK_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
} from '../theme/themeStorage';
import { toXtermTheme } from '../theme/xtermTheme';

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }) => {
  const [preference, setPreference] = useState(() => getStoredThemePreference());
  const [customThemePacks, setCustomThemePacks] = useState(() => getStoredCustomThemePacks());
  const [systemTick, setSystemTick] = useState(0);

  const availableThemePacks = useMemo(
    () => [...themePacks, ...customThemePacks],
    [customThemePacks],
  );

  const resolvedTheme = useMemo(
    () => resolveTheme(preference.themePackId, preference.themeMode, availableThemePacks),
    [availableThemePacks, preference.themeMode, preference.themePackId, systemTick],
  );

  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
    saveThemePreference(preference);
  }, [preference, resolvedTheme]);

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
    const handleStorage = (event) => {
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

  const setThemeMode = useCallback((themeMode) => {
    setPreference((current) => ({
      ...current,
      themeMode,
    }));
  }, []);

  const setThemePackId = useCallback((themePackId) => {
    setPreference((current) => ({
      ...current,
      themePackId: getThemePack(themePackId, availableThemePacks).id,
    }));
  }, [availableThemePacks]);

  const importCustomThemePack = useCallback((json) => {
    const pack = parseCustomThemePack(json);
    setCustomThemePacks((current) => {
      const next = [pack, ...current.filter((item) => item.id !== pack.id)];
      saveCustomThemePacks(next);
      return next;
    });
    setPreference((current) => ({
      ...current,
      themePackId: pack.id,
    }));
    return pack;
  }, []);

  const deleteCustomThemePack = useCallback((themePackId) => {
    setCustomThemePacks((current) => {
      const next = current.filter((pack) => pack.id !== themePackId);
      saveCustomThemePacks(next);
      return next;
    });
    setPreference((current) => (
      current.themePackId === themePackId
        ? { ...current, themePackId: getThemePack(null).id }
        : current
    ));
  }, []);

  const exportThemePack = useCallback((themePackId) => {
    const pack = getThemePack(themePackId, availableThemePacks);
    return {
      filename: getThemePackExportFilename(pack),
      content: stringifyThemePack(pack),
    };
  }, [availableThemePacks]);

  const toggleDarkMode = useCallback(() => {
    setPreference((current) => ({
      ...current,
      themeMode: resolvedTheme.mode === 'dark' ? 'light' : 'dark',
    }));
  }, [resolvedTheme.mode]);

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
      deleteCustomThemePack,
      exportThemePack,
      toggleDarkMode,
      resetTheme: () =>
        setPreference({
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
      deleteCustomThemePack,
      exportThemePack,
      toggleDarkMode,
      availableThemePacks,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};
