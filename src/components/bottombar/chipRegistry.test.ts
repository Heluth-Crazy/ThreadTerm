import { describe, expect, it } from 'vitest';
import { buildChipRegistry } from './chipRegistry';

describe('buildChipRegistry', () => {
  it('emits only currently enabled chips when context is full', () => {
    const chips = buildChipRegistry({
      cardCwd: '/home/u',
      bridgeAvailable: true,
      bookmarkCount: 3,
      unreadNotifications: 0,
    });
    expect(chips.map((c) => c.id)).toEqual([
      'notifications',
      'rich-input',
      'remote-control',
    ]);
    expect(chips.find((c) => c.id === 'file-explorer')).toBeUndefined();
    // Bookmarks feature is hidden via `lib/featureFlags.ts`; the chip must
    // disappear in lockstep with the top toolbar / side panel surfaces.
    expect(chips.find((c) => c.id === 'bookmarks')).toBeUndefined();
  });

  it('keeps file-explorer hidden when cwd is empty', () => {
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

  it('omits the bookmarks chip while the feature is hidden, regardless of count', () => {
    // The bookmark count is still honoured by the store / mirrored into the
    // chip context, but the bottom-bar chip is gated by the BOOKMARKS_VISIBLE
    // feature flag so neither the empty nor populated case should surface a
    // chip while the feature is hidden. Flipping the flag back on must
    // restore both the chip and its count-driven badge (covered by the
    // existing chip descriptor shape).
    const empty = buildChipRegistry({
      cardCwd: '/x',
      bridgeAvailable: true,
      bookmarkCount: 0,
      unreadNotifications: 0,
    });
    expect(empty.find((c) => c.id === 'bookmarks')).toBeUndefined();

    const filled = buildChipRegistry({
      cardCwd: '/x',
      bridgeAvailable: true,
      bookmarkCount: 7,
      unreadNotifications: 0,
    });
    expect(filled.find((c) => c.id === 'bookmarks')).toBeUndefined();
  });
});
