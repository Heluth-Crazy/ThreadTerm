import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  I18nProvider,
  MOBILE_LANGUAGE_PREFERENCE_KEY,
  readDesktopLanguageFromUrl,
  readMobileLanguagePreference,
  resolveMobileLanguage,
  useI18n,
} from './i18n';

function Probe() {
  const { t, language, preference, setPreference } = useI18n();
  return (
    <div>
      <span data-testid="lang">{language}</span>
      <span data-testid="pref">{preference}</span>
      <span data-testid="tab">{t('tab.terminal')}</span>
      <button type="button" onClick={() => setPreference('zh')}>
        to-zh
      </button>
    </div>
  );
}

describe('mobile i18n', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('reads the desktop language from the URL (zh* -> zh, anything else -> en)', () => {
    expect(readDesktopLanguageFromUrl('?lang=zh-CN')).toBe('zh');
    expect(readDesktopLanguageFromUrl('?lang=zh')).toBe('zh');
    expect(readDesktopLanguageFromUrl('?lang=en')).toBe('en');
    expect(readDesktopLanguageFromUrl('?lang=ja')).toBe('en');
    expect(readDesktopLanguageFromUrl('')).toBeNull();
  });

  it('resolves auto to the desktop language and defaults to English when absent', () => {
    expect(resolveMobileLanguage('auto', 'zh')).toBe('zh');
    expect(resolveMobileLanguage('auto', 'en')).toBe('en');
    expect(resolveMobileLanguage('auto', null)).toBe('en');
    expect(resolveMobileLanguage('zh', null)).toBe('zh');
    expect(resolveMobileLanguage('en', 'zh')).toBe('en');
  });

  it('defaults the stored preference to auto', () => {
    expect(readMobileLanguagePreference()).toBe('auto');
  });

  it('follows the desktop lang param when preference is auto', () => {
    render(
      <I18nProvider search="?lang=zh-CN">
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByTestId('pref').textContent).toBe('auto');
    expect(screen.getByTestId('lang').textContent).toBe('zh');
    expect(screen.getByTestId('tab').textContent).toBe('终端');
  });

  it('defaults to English when no desktop lang and no stored preference', () => {
    render(
      <I18nProvider search="">
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByTestId('lang').textContent).toBe('en');
    expect(screen.getByTestId('tab').textContent).toBe('Terminal');
  });

  it('lets the user override and persists the choice', () => {
    render(
      <I18nProvider search="?lang=en">
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByTestId('lang').textContent).toBe('en');
    fireEvent.click(screen.getByText('to-zh'));

    expect(screen.getByTestId('pref').textContent).toBe('zh');
    expect(screen.getByTestId('lang').textContent).toBe('zh');
    expect(screen.getByTestId('tab').textContent).toBe('终端');
    expect(window.localStorage.getItem(MOBILE_LANGUAGE_PREFERENCE_KEY)).toBe('zh');
  });
});
