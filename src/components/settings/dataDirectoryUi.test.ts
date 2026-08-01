import { describe, expect, it } from 'vitest';
import { formatDataPathForDisplay } from './dataDirectoryUi';

describe('formatDataPathForDisplay', () => {
  it('hides the Windows verbatim prefix from drive paths', () => {
    expect(formatDataPathForDisplay('\\\\?\\D:\\project\\ThreadTermData')).toBe(
      'D:\\project\\ThreadTermData',
    );
  });

  it('restores the familiar UNC form for verbatim network paths', () => {
    expect(
      formatDataPathForDisplay('\\\\?\\UNC\\server\\share\\ThreadTermData'),
    ).toBe('\\\\server\\share\\ThreadTermData');
  });

  it('leaves normal Windows and macOS paths unchanged', () => {
    expect(formatDataPathForDisplay('D:\\project\\ThreadTermData')).toBe(
      'D:\\project\\ThreadTermData',
    );
    expect(formatDataPathForDisplay('/Users/tester/ThreadTermData')).toBe(
      '/Users/tester/ThreadTermData',
    );
  });
});
