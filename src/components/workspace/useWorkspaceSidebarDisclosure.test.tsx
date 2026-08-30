import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MANAGED_STATE_KEYS,
  resetManagedStateCacheForTests,
} from '../../lib/managedState';
import {
  __resetWorkspaceSidebarDisclosureForTests,
  getWorkspaceSidebarDisclosure,
  parseWorkspaceSidebarDisclosure,
  useWorkspaceSidebarDisclosure,
} from './useWorkspaceSidebarDisclosure';

beforeEach(() => {
  localStorage.clear();
  resetManagedStateCacheForTests();
  __resetWorkspaceSidebarDisclosureForTests();
  vi.restoreAllMocks();
});
describe('workspace sidebar disclosure', () => {
  it('defaults Sessions open and Files/Changes closed', () => {
    expect(getWorkspaceSidebarDisclosure('/repo')).toEqual({
      sessions: true,
      files: false,
      changes: false,
    });
  });

  it('persists choices by normalized root across remounts', () => {
    const { result, unmount } = renderHook(() => (
      useWorkspaceSidebarDisclosure('D:\\Repo\\App\\')
    ));
    act(() => result.current.toggleCategory('files'));
    expect(result.current.state.files).toBe(true);
    unmount();

    __resetWorkspaceSidebarDisclosureForTests();
    const next = renderHook(() => useWorkspaceSidebarDisclosure('\\\\?\\d:\\repo\\app'));
    expect(next.result.current.state.files).toBe(true);
    expect(localStorage.getItem(MANAGED_STATE_KEYS.workspaceSidebarDisclosure)).toContain(
      '"files":true',
    );
  });

  it('fails soft for malformed and unknown versions', () => {
    expect(parseWorkspaceSidebarDisclosure('{bad')).toEqual(new Map());
    expect(parseWorkspaceSidebarDisclosure(JSON.stringify({ version: 2, scopes: {} })))
      .toEqual(new Map());
  });

  it('keeps only the 256 newest persisted scopes', () => {
    const document = {
      version: 1,
      scopes: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [
        `/repo/${index}`,
        { sessions: true, files: false, changes: false, updatedAt: index },
      ])),
    };
    const parsed = parseWorkspaceSidebarDisclosure(JSON.stringify(document));
    expect(parsed).toHaveLength(256);
    expect(parsed.has('/repo/299')).toBe(true);
    expect(parsed.has('/repo/0')).toBe(false);
  });
});
