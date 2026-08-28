import { describe, expect, it } from 'vitest';
import {
  MAX_PINNED_PROJECTS,
  normalizePinnedProjects,
  reconcilePinnedProjectPaths,
} from './pinnedProjects';

describe('pinnedProjects', () => {
  it('removes invalid and duplicate entries and caps at the max', () => {
    expect(
      normalizePinnedProjects([
        'D:\\Project\\ThreadTerm',
        '/Users/me/ThreadTerm',
        '',
        '   ',
        42,
        'D:\\Project\\ThreadTerm',
        '/a',
        '/b',
        '/c',
        '/d',
        '/e',
        '/f',
      ]),
    ).toEqual([
      'D:\\Project\\ThreadTerm',
      '/Users/me/ThreadTerm',
      '/a',
      '/b',
      '/c',
      '/d',
    ]);
  });

  it('returns an empty list for non-array input', () => {
    expect(normalizePinnedProjects(undefined)).toEqual([]);
    expect(normalizePinnedProjects(null)).toEqual([]);
    expect(normalizePinnedProjects('/repo/a')).toEqual([]);
  });

  it('exposes a stable max of six pinned projects', () => {
    expect(MAX_PINNED_PROJECTS).toBe(6);
  });

  it('prunes pinned paths that no longer exist without appending new ones', () => {
    expect(
      reconcilePinnedProjectPaths(
        ['/repo/b', '/repo/stale', '/repo/a'],
        ['/repo/a', '/repo/b', '/repo/c'],
      ),
    ).toEqual(['/repo/b', '/repo/a']);
  });
});
