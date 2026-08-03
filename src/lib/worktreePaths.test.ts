import { describe, expect, it } from 'vitest';
import { normalizeComparablePath, samePath } from './worktreePaths';

describe('worktree path comparison', () => {
  it('treats a Windows verbatim drive path as the same workspace root', () => {
    expect(samePath('\\\\?\\D:\\project\\ThreadTerm', 'D:\\project\\ThreadTerm')).toBe(
      true,
    );
  });

  it('treats a Windows verbatim UNC path as the same network workspace root', () => {
    expect(
      samePath(
        '\\\\?\\UNC\\server\\share\\ThreadTerm',
        '\\\\server\\share\\ThreadTerm',
      ),
    ).toBe(true);
  });

  it('keeps different workspace roots distinct after normalization', () => {
    expect(
      normalizeComparablePath('D:\\project\\ThreadTerm'),
    ).not.toBe(normalizeComparablePath('D:\\project\\Other'));
  });

  it('keeps same-name projects, parent/child roots, and different drives distinct', () => {
    expect(samePath('C:\\one\\app', 'D:\\one\\app')).toBe(false);
    expect(samePath('C:\\one\\app', 'C:\\two\\app')).toBe(false);
    expect(samePath('C:\\one\\app', 'C:\\one\\app\\child')).toBe(false);
  });

  it('normalizes Windows separators and drive case without folding macOS case', () => {
    expect(samePath('d:\\Repo\\App\\', 'D:/repo/app')).toBe(true);
    expect(samePath('/Users/demo/App', '/Users/demo/app')).toBe(false);
    expect(samePath('/Users/one/App', '/Users/two/App')).toBe(false);
  });
});
