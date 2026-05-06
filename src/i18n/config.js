import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import { languages } from './languages.js';

import enCommon from './locales/en/common.json';
import enSettings from './locales/en/settings.json';
import enTerminal from './locales/en/terminal.json';
import enOverlay from './locales/en/overlay.json';
import enSupervisor from './locales/en/supervisor.json';
import koCommon from './locales/ko/common.json';
import koSettings from './locales/ko/settings.json';
import koTerminal from './locales/ko/terminal.json';
import koOverlay from './locales/ko/overlay.json';
import koSupervisor from './locales/ko/supervisor.json';
import zhCommon from './locales/zh-CN/common.json';
import zhSettings from './locales/zh-CN/settings.json';
import zhTerminal from './locales/zh-CN/terminal.json';
import zhOverlay from './locales/zh-CN/overlay.json';
import zhSupervisor from './locales/zh-CN/supervisor.json';
import jaCommon from './locales/ja/common.json';
import jaSettings from './locales/ja/settings.json';
import jaTerminal from './locales/ja/terminal.json';
import jaOverlay from './locales/ja/overlay.json';
import jaSupervisor from './locales/ja/supervisor.json';

const getSavedLanguage = () => {
  if (typeof window === 'undefined') {
    return 'zh-CN';
  }

  try {
    const saved = window.localStorage.getItem('userLanguage');
    const supported = new Set(languages.map((language) => language.value));
    if (saved && supported.has(saved)) {
      return saved;
    }
  } catch (error) {
    console.error('Failed to read saved language:', error);
  }

  return 'zh-CN';
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: enCommon,
        settings: enSettings,
        terminal: enTerminal,
        overlay: enOverlay,
        supervisor: enSupervisor,
      },
      ko: {
        common: koCommon,
        settings: koSettings,
        terminal: koTerminal,
        overlay: koOverlay,
        supervisor: koSupervisor,
      },
      'zh-CN': {
        common: zhCommon,
        settings: zhSettings,
        terminal: zhTerminal,
        overlay: zhOverlay,
        supervisor: zhSupervisor,
      },
      ja: {
        common: jaCommon,
        settings: jaSettings,
        terminal: jaTerminal,
        overlay: jaOverlay,
        supervisor: jaSupervisor,
      },
    },
    lng: getSavedLanguage(),
    fallbackLng: 'zh-CN',
    debug: import.meta.env.DEV,
    ns: ['common', 'settings', 'terminal', 'overlay', 'supervisor'],
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

i18n.on('languageChanged', (lng) => {
  try {
    localStorage.setItem('userLanguage', lng);
  } catch (error) {
    console.error('Failed to save language preference:', error);
  }
});

export default i18n;
