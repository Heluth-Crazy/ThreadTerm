import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

// Minimal mobile i18n. The desktop app uses react-i18next with en/ko/zh-CN/ja,
// but the mobile shell only needs Chinese/English (the user requirement) and
// must stay dependency-light, so this is a tiny typed dictionary instead of a
// full i18n runtime.

export type MobileLanguage = 'zh' | 'en';
export type MobileLanguagePreference = 'auto' | MobileLanguage;

export const MOBILE_LANGUAGE_PREFERENCE_KEY = 'threadterm.mobile.languagePreference';

type Dict = Record<string, string>;

const en: Dict = {
  'pair.eyebrow': 'ThreadTerm Mobile',
  'pair.title.has': 'Pair this device',
  'pair.title.none': 'Pairing code required',
  'pair.deviceName': 'Device name',
  'pair.full': 'Full-control pairing',
  'pair.readonly': 'Read-only pairing',
  'pair.button.idle': 'Pair device',
  'pair.button.busy': 'Pairing...',
  'pair.reopen': 'Reopen the QR link from ThreadTerm Desktop.',
  'home.syncQr': 'Sync via QR Code',
  'home.connection': 'Connection',
  'home.session': 'session',
  'home.sessions': 'sessions',
  'home.activeSession': 'Active Session',
  'home.allSessions': 'All Sessions',
  'home.tapFocus': 'Tap to focus',
  'home.noSessions': 'No live terminal sessions yet.',
  'home.searchPlaceholder': 'Search sessions...',
  'home.searchLabel': 'Search sessions',
  'home.noMatches': 'No matching sessions.',
  'banner.reconnecting': 'Reconnecting…',
  'banner.offline': 'Connection lost',
  'instances.title': 'Instances',
  'instances.empty': 'No sessions from the bridge yet.',
  'instances.warmingUp': 'Waiting for desktop card sync...',
  'instances.newSession': 'New session',
  'instances.projectPath': 'Project path',
  'instances.terminalType': 'Terminal type',
  'instances.command': 'Command',
  'instances.create': 'Create',
  'instances.activate': 'Start / resume',
  'instances.delete': 'Delete session',
  'instances.rename': 'Rename',
  'instances.renamePrompt': 'New card name',
  'settings.title': 'Settings',
  'settings.mobileBridge': 'Mobile bridge',
  'settings.websocket': 'WebSocket',
  'settings.pty': 'PTY',
  'settings.recentOutput': 'Recent output',
  'settings.device': 'Device',
  'settings.lastError': 'Last error',
  'settings.appearance': 'Appearance',
  'settings.appearance.auto': 'auto',
  'settings.appearance.dark': 'dark',
  'settings.appearance.light': 'light',
  'settings.language': 'Language',
  'settings.language.auto': 'Follow desktop',
  'settings.language.zh': '中文',
  'settings.language.en': 'English',
  'settings.notifications': 'Notifications',
  'settings.noNotifications': 'No active notifications.',
  'detail.back': 'Back',
  'detail.terminal': 'Terminal',
  'detail.notLive': 'This session is idle on desktop.',
  'detail.readonly': 'Read-only device',
  'scanner.cancel': 'Cancel',
  'scanner.title': 'Scan Code',
  'tab.terminal': 'Terminal',
  'tab.instances': 'Instances',
  'tab.settings': 'Settings',
  'common.fullControl': 'Full control',
  'common.readonly': 'Read-only',
  'common.cancel': 'Cancel',
};

const zh: Dict = {
  'pair.eyebrow': 'ThreadTerm 移动端',
  'pair.title.has': '配对此设备',
  'pair.title.none': '需要配对码',
  'pair.deviceName': '设备名称',
  'pair.full': '完全控制配对',
  'pair.readonly': '只读配对',
  'pair.button.idle': '配对设备',
  'pair.button.busy': '配对中...',
  'pair.reopen': '请重新打开 ThreadTerm 桌面端的二维码链接。',
  'home.syncQr': '扫码同步',
  'home.connection': '连接',
  'home.session': '个会话',
  'home.sessions': '个会话',
  'home.activeSession': '当前会话',
  'home.allSessions': '全部会话',
  'home.tapFocus': '点击进入',
  'home.noSessions': '暂无活动的终端会话。',
  'home.searchPlaceholder': '搜索会话…',
  'home.searchLabel': '搜索会话',
  'home.noMatches': '没有匹配的会话。',
  'banner.reconnecting': '重连中…',
  'banner.offline': '连接已断开',
  'instances.title': '实例',
  'instances.empty': '桥接还没有同步到会话。',
  'instances.warmingUp': '正在等待桌面端同步卡片...',
  'instances.newSession': '新建会话',
  'instances.projectPath': '项目路径',
  'instances.terminalType': '终端类型',
  'instances.command': '命令',
  'instances.create': '创建',
  'instances.activate': '启动/恢复',
  'instances.delete': '删除会话',
  'instances.rename': '重命名',
  'instances.renamePrompt': '新的卡片名称',
  'settings.title': '设置',
  'settings.mobileBridge': '移动桥接',
  'settings.websocket': 'WebSocket',
  'settings.pty': 'PTY',
  'settings.recentOutput': '近期输出',
  'settings.device': '设备',
  'settings.lastError': '最近错误',
  'settings.appearance': '外观',
  'settings.appearance.auto': '自动',
  'settings.appearance.dark': '深色',
  'settings.appearance.light': '浅色',
  'settings.language': '语言',
  'settings.language.auto': '跟随桌面',
  'settings.language.zh': '中文',
  'settings.language.en': 'English',
  'settings.notifications': '通知',
  'settings.noNotifications': '没有通知。',
  'detail.back': '返回',
  'detail.terminal': '终端',
  'detail.notLive': '这个会话当前未在桌面端运行。',
  'detail.readonly': '只读设备',
  'scanner.cancel': '取消',
  'scanner.title': '扫描二维码',
  'tab.terminal': '终端',
  'tab.instances': '实例',
  'tab.settings': '设置',
  'common.fullControl': '完全控制',
  'common.readonly': '只读',
  'common.cancel': '取消',
};

const DICTS: Record<MobileLanguage, Dict> = { en, zh };

function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readMobileLanguagePreference(
  storage: Storage | undefined = safeStorage(),
): MobileLanguagePreference {
  const stored = storage?.getItem(MOBILE_LANGUAGE_PREFERENCE_KEY);
  return stored === 'zh' || stored === 'en' || stored === 'auto' ? stored : 'auto';
}

export function saveMobileLanguagePreference(
  preference: MobileLanguagePreference,
  storage: Storage | undefined = safeStorage(),
) {
  storage?.setItem(MOBILE_LANGUAGE_PREFERENCE_KEY, preference);
}

// The desktop injects its current language into the pairing URL (?lang=...),
// mirroring how it already injects theme_* colors. Desktop codes are
// en/ko/zh-CN/ja; the mobile shell only renders Chinese vs. English, so
// anything starting with "zh" is Chinese and everything else is English.
export function readDesktopLanguageFromUrl(search: string): MobileLanguage | null {
  const raw = new URLSearchParams(search).get('lang');
  if (!raw) return null;
  return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function resolveMobileLanguage(
  preference: MobileLanguagePreference,
  desktopLanguage: MobileLanguage | null,
): MobileLanguage {
  if (preference === 'zh' || preference === 'en') return preference;
  // auto → follow desktop; default to English when the desktop did not say.
  return desktopLanguage ?? 'en';
}

export interface MobileI18n {
  language: MobileLanguage;
  preference: MobileLanguagePreference;
  setPreference: (preference: MobileLanguagePreference) => void;
  t: (key: keyof typeof en) => string;
}

const I18nContext = createContext<MobileI18n | null>(null);

export function I18nProvider({
  children,
  search,
}: {
  children: ReactNode;
  search: string;
}) {
  const desktopLanguage = useMemo(() => readDesktopLanguageFromUrl(search), [search]);
  const [preference, setPreferenceState] = useState<MobileLanguagePreference>(() =>
    readMobileLanguagePreference(),
  );

  const setPreference = useCallback((next: MobileLanguagePreference) => {
    saveMobileLanguagePreference(next);
    setPreferenceState(next);
  }, []);

  const value = useMemo<MobileI18n>(() => {
    const language = resolveMobileLanguage(preference, desktopLanguage);
    const dict = DICTS[language];
    return {
      language,
      preference,
      setPreference,
      t: (key) => dict[key] ?? en[key] ?? String(key),
    };
  }, [desktopLanguage, preference, setPreference]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): MobileI18n {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
}
