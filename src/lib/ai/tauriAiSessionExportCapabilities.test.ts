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

  it('does not keep removed workflow-specific fs or http scopes', () => {
    expect(hasPermission('http:default')).toBe(false);
    expect(hasPermission('fs:allow-read-dir')).toBe(false);
    expect(hasPermission('fs:allow-read-text-file')).toBe(false);
    expect(
      permissions.some(
        (permission) => typeof permission !== 'string' && permission.identifier === 'fs:scope',
      ),
    ).toBe(false);
  });
});
