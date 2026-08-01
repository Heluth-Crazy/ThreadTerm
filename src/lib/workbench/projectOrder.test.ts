import { describe, expect, it } from 'vitest';
import {
  moveProjectPath,
  normalizeProjectOrder,
  orderProjectItems,
  reconcileProjectPathOrder,
} from './projectOrder';

interface ProjectItem {
  name: string;
  path: string;
}

const getPath = (project: ProjectItem) => project.path;
const getName = (project: ProjectItem) => project.name;

describe('projectOrder', () => {
  it('keeps raw project paths while removing invalid and duplicate entries', () => {
    expect(
      normalizeProjectOrder([
        'D:\\Project\\ThreadTerm',
        '/Users/me/ThreadTerm',
        '',
        '   ',
        42,
        'D:\\Project\\ThreadTerm',
      ]),
    ).toEqual(['D:\\Project\\ThreadTerm', '/Users/me/ThreadTerm']);
  });

  it('uses stored paths first and appends new projects deterministically', () => {
    const projects: ProjectItem[] = [
      { name: 'Zulu', path: '/zulu' },
      { name: 'Alpha', path: '/alpha-2' },
      { name: 'Alpha', path: '/alpha-1' },
    ];

    expect(
      orderProjectItems(projects, ['/zulu'], getPath, getName).map(
        (project) => project.path,
      ),
    ).toEqual(['/zulu', '/alpha-1', '/alpha-2']);
    expect(projects.map((project) => project.path)).toEqual([
      '/zulu',
      '/alpha-2',
      '/alpha-1',
    ]);
  });

  it('removes stale paths and appends newly discovered projects', () => {
    expect(
      reconcileProjectPathOrder(
        ['/repo/b', '/repo/stale', '/repo/a'],
        ['/repo/a', '/repo/b', '/repo/c'],
      ),
    ).toEqual(['/repo/b', '/repo/a', '/repo/c']);
  });

  it('reorders visible projects without moving hidden projects out of place', () => {
    expect(
      moveProjectPath(
        ['/repo/a', '/repo/hidden', '/repo/c', '/repo/d'],
        '/repo/d',
        '/repo/a',
        ['/repo/a', '/repo/c', '/repo/d'],
      ),
    ).toEqual(['/repo/d', '/repo/hidden', '/repo/a', '/repo/c']);
  });

  it('ignores a move when either endpoint is outside the visible project set', () => {
    expect(
      moveProjectPath(
        ['/repo/a', '/repo/b'],
        '/repo/b',
        '/repo/missing',
        ['/repo/a', '/repo/b'],
      ),
    ).toEqual(['/repo/a', '/repo/b']);
  });
});
