import i18n from 'i18next';
import type { Resource, ResourceLanguage } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import { logger } from '../lib/logger';
import { languages } from './languages';

import zhCommon from './locales/zh-CN/common.json';
import zhSettings from './locales/zh-CN/settings.json';
import zhTerminal from './locales/zh-CN/terminal.json';
import zhOverlay from './locales/zh-CN/overlay.json';
import zhSupervisor from './locales/zh-CN/supervisor.json';

type SupportedLanguage = 'en' | 'ko' | 'zh-CN' | 'ja';
type LazyLanguage = Exclude<SupportedLanguage, 'zh-CN'>;

const FALLBACK_LANGUAGE: SupportedLanguage = 'zh-CN';
const NAMESPACES = ['common', 'settings', 'terminal', 'overlay', 'supervisor'] as const;
type Namespace = (typeof NAMESPACES)[number];
type ResourceBundle = Record<Namespace, ResourceLanguage>;
type ResourceLoaders = Record<LazyLanguage, Record<Namespace, () => Promise<{ default: ResourceLanguage }>>>;

const SUPPORTED_LANGUAGES = new Set<SupportedLanguage>(
  languages.map((language) => language.value as SupportedLanguage),
);
const resourceLoaders: ResourceLoaders = {
  en: {
    common: () => import('./locales/en/common.json'),
    settings: () => import('./locales/en/settings.json'),
    terminal: () => import('./locales/en/terminal.json'),
    overlay: () => import('./locales/en/overlay.json'),
    supervisor: () => import('./locales/en/supervisor.json'),
  },
  ko: {
    common: () => import('./locales/ko/common.json'),
    settings: () => import('./locales/ko/settings.json'),
    terminal: () => import('./locales/ko/terminal.json'),
    overlay: () => import('./locales/ko/overlay.json'),
    supervisor: () => import('./locales/ko/supervisor.json'),
  },
  ja: {
    common: () => import('./locales/ja/common.json'),
    settings: () => import('./locales/ja/settings.json'),
    terminal: () => import('./locales/ja/terminal.json'),
    overlay: () => import('./locales/ja/overlay.json'),
    supervisor: () => import('./locales/ja/supervisor.json'),
  },
};

const fallbackResources: ResourceBundle = {
  common: zhCommon,
  settings: zhSettings,
  terminal: zhTerminal,
  overlay: zhOverlay,
  supervisor: zhSupervisor,
};

function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.has(value as SupportedLanguage);
}

const getSavedLanguage = (): SupportedLanguage => {
  if (typeof window === 'undefined') {
    return FALLBACK_LANGUAGE;
  }

  try {
    const saved = window.localStorage.getItem('userLanguage');
    if (isSupportedLanguage(saved)) {
      return saved;
    }
  } catch (error) {
    logger.error('Failed to read saved language:', error);
  }

  return FALLBACK_LANGUAGE;
};

async function loadLanguageResources(lng: SupportedLanguage): Promise<ResourceBundle> {
  if (lng === FALLBACK_LANGUAGE) {
    return fallbackResources;
  }

  const loaders = resourceLoaders[lng as LazyLanguage];
  const entries = await Promise.all(
    NAMESPACES.map(async (namespace) => {
      const mod = await loaders[namespace]();
      return [namespace, mod.default];
    }),
  );
  return Object.fromEntries(entries);
}

async function ensureLanguageResources(lng: string | undefined): Promise<SupportedLanguage> {
  const language = isSupportedLanguage(lng) ? lng : FALLBACK_LANGUAGE;
  if (NAMESPACES.every((namespace) => i18n.hasResourceBundle(language, namespace))) {
    return language;
  }

  const resources = await loadLanguageResources(language);
  for (const namespace of NAMESPACES) {
    i18n.addResourceBundle(language, namespace, resources[namespace], true, true);
  }
  return language;
}

const initialLanguage = getSavedLanguage();
const initialResources: Resource = {
  [FALLBACK_LANGUAGE]: fallbackResources,
};
if (initialLanguage !== FALLBACK_LANGUAGE) {
  initialResources[initialLanguage] = await loadLanguageResources(initialLanguage);
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: initialResources,
    lng: initialLanguage,
    fallbackLng: FALLBACK_LANGUAGE,
    debug: import.meta.env.DEV,
    ns: NAMESPACES,
    defaultNS: 'common',
    keySeparator: '.',
    nsSeparator: ':',
    saveMissing: false,
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: true,
      bindI18n: 'languageChanged',
      bindI18nStore: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'userLanguage',
      caches: ['localStorage'],
    },
  });

const changeLanguage = i18n.changeLanguage.bind(i18n);
i18n.changeLanguage = async (lng, callback) => {
  if (typeof lng === 'string') {
    const language = await ensureLanguageResources(lng);
    return changeLanguage(language, callback);
  }
  return changeLanguage(lng, callback);
};

i18n.on('languageChanged', (lng) => {
  try {
    localStorage.setItem('userLanguage', lng);
  } catch (error) {
    logger.error('Failed to save language preference:', error);
  }
});

export { ensureLanguageResources };
export default i18n;
