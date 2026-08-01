import { describe, expect, it } from 'vitest';
import en from './locales/en/settings.json';
import ja from './locales/ja/settings.json';
import ko from './locales/ko/settings.json';
import zhCN from './locales/zh-CN/settings.json';

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('settings locale key parity', () => {
  it.each([
    ['zh-CN', zhCN],
    ['ja', ja],
    ['ko', ko],
  ])('%s exposes the same settings keys as English', (_locale, messages) => {
    expect(flattenKeys(messages).sort()).toEqual(flattenKeys(en).sort());
  });
});
