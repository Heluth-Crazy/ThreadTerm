import { describe, expect, it } from 'vitest';
import en from './locales/en/terminal.json';
import zhCN from './locales/zh-CN/terminal.json';
import ja from './locales/ja/terminal.json';
import ko from './locales/ko/terminal.json';

type LocaleTree = Record<string, unknown>;

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as LocaleTree).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('terminal locale key parity', () => {
  it('keeps every terminal locale on the same key tree', () => {
    const expected = flattenKeys(en).sort();
    const locales = {
      'zh-CN': zhCN,
      ja,
      ko,
    };

    for (const [locale, tree] of Object.entries(locales)) {
      expect(flattenKeys(tree).sort(), locale).toEqual(expected);
    }
  });

  it('localizes workspace relative activity outside English', () => {
    const englishValues = Object.values(en.workspace).filter((value) =>
      typeof value === 'string' && /Just now|ago/.test(value),
    );
    for (const [locale, messages] of Object.entries({ 'zh-CN': zhCN, ja, ko })) {
      const activity = [
        messages.workspace.activityJustNow,
        messages.workspace.activityMinutes,
        messages.workspace.activityHours,
        messages.workspace.activityDays,
      ];
      expect(activity, locale).not.toEqual(expect.arrayContaining(englishValues));
      expect(activity.every((value) => !/Just now|ago/.test(value)), locale).toBe(true);
    }
  });
});
