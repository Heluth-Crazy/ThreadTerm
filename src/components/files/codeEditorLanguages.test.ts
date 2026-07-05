import { describe, expect, it } from 'vitest';
import {
  SYNTAX_HIGHLIGHT_MAX_BYTES,
  loadLanguageExtensions,
  shouldSyntaxHighlight,
} from './codeEditorLanguages';

describe('codeEditorLanguages', () => {
  it.each([
    ['TypeScript', 'src/App.tsx'],
    ['Rust', 'src-tauri/src/lib.rs'],
    ['Go', 'cmd/server/main.go'],
    ['Java', 'src/main/java/App.java'],
    ['C++', 'src/native/addon.cpp'],
    ['PHP', 'public/index.php'],
    ['SQL', 'schema/init.sql'],
    ['Shell', 'scripts/build.sh'],
    ['PowerShell', 'scripts/build.ps1'],
    ['TOML', 'Cargo.toml'],
    ['Dockerfile', 'Dockerfile'],
    ['properties', '.env'],
  ])('loads %s syntax support', async (_label, path) => {
    await expect(loadLanguageExtensions(path)).resolves.not.toHaveLength(0);
  });

  it('keeps unknown extensions as plain text', async () => {
    await expect(loadLanguageExtensions('notes.unknown-ext')).resolves.toHaveLength(0);
  });

  it('disables syntax highlighting for large files', () => {
    expect(shouldSyntaxHighlight('a'.repeat(SYNTAX_HIGHLIGHT_MAX_BYTES))).toBe(true);
    expect(shouldSyntaxHighlight('a'.repeat(SYNTAX_HIGHLIGHT_MAX_BYTES + 1))).toBe(false);
  });
});
