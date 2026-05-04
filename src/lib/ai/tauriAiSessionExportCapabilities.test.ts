import { describe, expect, it } from 'vitest';
import defaultCapability from '../../../src-tauri/capabilities/default.json';

interface PermissionObject {
  identifier: string;
  allow?: Array<{ path?: string; url?: string }>;
}

type Permission = string | PermissionObject;

const permissions = defaultCapability.permissions as Permission[];

function hasPermission(identifier: string): boolean {
  return permissions.some((permission) =>
    typeof permission === 'string'
      ? permission === identifier
      : permission.identifier === identifier,
  );
}

describe('AI session export Tauri capability contract', () => {
  it('permits dialog-selected Markdown saves through dialog save plus fs text writes', () => {
    expect(defaultCapability.windows).toContain('main');
    expect(hasPermission('dialog:allow-save')).toBe(true);
    expect(hasPermission('fs:allow-write-text-file')).toBe(true);
  });

  it('keeps workflow fs scope intact while relying on dialog.save for user-selected export paths', () => {
    const fsScope = permissions.find(
      (permission): permission is PermissionObject =>
        typeof permission !== 'string' && permission.identifier === 'fs:scope',
    );

    expect(fsScope?.allow).toEqual(
      expect.arrayContaining([
        { path: '$HOME/.threadterm/workflows' },
        { path: '$HOME/.threadterm/workflows/**' },
        { path: '**/.threadterm/workflows' },
        { path: '**/.threadterm/workflows/**' },
      ]),
    );
  });
});
