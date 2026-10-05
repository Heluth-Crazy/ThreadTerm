import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localeFromSettings, translate } from './i18n';

test('missing language uses English before and after settings load', () => {
  for (const settings of [undefined, {}, { language: undefined }]) {
    const locale = localeFromSettings(settings);
    assert.equal(locale, 'en');
    assert.equal(translate(locale, 'settings'), 'Settings');
  }
});

test('Chinese requires the exact persisted language value', () => {
  assert.equal(localeFromSettings({ language: 'en' }), 'en');
  const locale = localeFromSettings({ language: 'zh-CN' });
  assert.equal(locale, 'zh-CN');
  assert.equal(translate(locale, 'settings'), '设置');
});

test('unrecognized language values fall back to English', () => {
  for (const language of [null, '', 'zh', 'zh-cn', 'ZH-CN', 'fr', ' zh-CN ', false, 0, {}, ['zh-CN']]) {
    assert.equal(localeFromSettings({ language }), 'en');
  }
});
