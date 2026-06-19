import { describe, expect, it } from 'vitest';
import { matchesCardQuery } from './cardSearch';

const card = {
  projectName: 'My Frontend App',
  projectPath: '/Users/me/repos/web-client',
  worktreePath: '/Users/me/repos/web-client/wt-feature',
  terminalType: 'claude',
};

describe('matchesCardQuery', () => {
  it('matches everything for a blank query', () => {
    expect(matchesCardQuery(card, '')).toBe(true);
    expect(matchesCardQuery(card, '   ')).toBe(true);
  });

  it('matches by project name', () => {
    expect(matchesCardQuery(card, 'frontend')).toBe(true);
  });

  it('matches by project path', () => {
    expect(matchesCardQuery(card, 'web-client')).toBe(true);
  });

  it('matches by worktree path', () => {
    expect(matchesCardQuery(card, 'wt-feature')).toBe(true);
  });

  it('matches by terminal type', () => {
    expect(matchesCardQuery(card, 'claude')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesCardQuery(card, 'FRONTEND')).toBe(true);
  });

  it('returns false when nothing matches', () => {
    expect(matchesCardQuery(card, 'zzz-nope')).toBe(false);
  });

  it('handles a missing worktreePath', () => {
    expect(
      matchesCardQuery({ projectName: 'alpha', projectPath: '/a', terminalType: 'shell' }, 'alpha'),
    ).toBe(true);
  });
});
