import { describe, expect, it } from 'vitest';
import { buildChipRegistry } from './chipRegistry';

describe('buildChipRegistry', () => {
  it('emits all six default chips when context is full', () => {
    const chips = buildChipRegistry({
      cardCwd: '/home/u',
      bridgeAvailable: true,
      bookmarkCount: 3,
      unreadNotifications: 0,
    });
    expect(chips.map((c) => c.id)).toEqual([
      'notifications',
      'bookmarks',
      'workflows',
      'file-explorer',
      'rich-input',
      'remote-control',
    ]);
  });

  it('hides file-explorer when cwd is empty', () => {
    const chips = buildChipRegistry({
      cardCwd: '',
      bridgeAvailable: true,
      bookmarkCount: 0,
      unreadNotifications: 0,
    });
    expect(chips.find((c) => c.id === 'file-explorer')).toBeUndefined();
  });

  it('marks notifications dot when unread > 0', () => {
    const chips = buildChipRegistry({
      cardCwd: '/x',
      bridgeAvailable: true,
      bookmarkCount: 0,
      unreadNotifications: 4,
    });
    const n = chips.find((c) => c.id === 'notifications');
    expect(n?.badge).toBe(4);
  });

  it('hides remote-control when bridge unavailable', () => {
    const chips = buildChipRegistry({
      cardCwd: '/x',
      bridgeAvailable: false,
      bookmarkCount: 0,
      unreadNotifications: 0,
    });
    expect(chips.find((c) => c.id === 'remote-control')).toBeUndefined();
  });

  it('emits bookmark badge only when count > 0', () => {
    const empty = buildChipRegistry({
      cardCwd: '/x',
      bridgeAvailable: true,
      bookmarkCount: 0,
      unreadNotifications: 0,
    });
    expect(empty.find((c) => c.id === 'bookmarks')?.badge).toBeUndefined();

    const filled = buildChipRegistry({
      cardCwd: '/x',
      bridgeAvailable: true,
      bookmarkCount: 7,
      unreadNotifications: 0,
    });
    expect(filled.find((c) => c.id === 'bookmarks')?.badge).toBe(7);
  });
});
