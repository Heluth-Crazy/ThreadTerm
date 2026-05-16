import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PET_CONFIG,
  normalizePetConfig,
  notificationModeToToggles,
  togglesToNotificationMode,
} from './petConfig';

describe('petConfig', () => {
  it('defaults to an opt-in pet that surfaces on the pet and the OS', () => {
    expect(normalizePetConfig(null)).toEqual(DEFAULT_PET_CONFIG);
    expect(DEFAULT_PET_CONFIG.notificationMode).toBe('both');
    expect(DEFAULT_PET_CONFIG.skin).toBe('classic');
  });

  it('keeps a known skin and drops an invalid one', () => {
    expect(normalizePetConfig({ skin: 'tuxedo' } as never).skin).toBe('tuxedo');
    expect(normalizePetConfig({ skin: 'rainbow' } as never).skin).toBe('classic');
  });

  it('maps notificationMode to/from the two UI toggles', () => {
    expect(notificationModeToToggles('both')).toEqual({ petBubble: true, osNotification: true });
    expect(notificationModeToToggles('pet')).toEqual({ petBubble: true, osNotification: false });
    expect(notificationModeToToggles('system')).toEqual({
      petBubble: false,
      osNotification: true,
    });
    expect(notificationModeToToggles('off')).toEqual({ petBubble: false, osNotification: false });

    expect(togglesToNotificationMode(true, true)).toBe('both');
    expect(togglesToNotificationMode(true, false)).toBe('pet');
    expect(togglesToNotificationMode(false, true)).toBe('system');
    expect(togglesToNotificationMode(false, false)).toBe('off');
  });

  it('clamps size and drops invalid enum values plus unknown fields', () => {
    const normalized = normalizePetConfig({
      enabled: true,
      notificationMode: 'invalid',
      defaultPosition: 'somewhere',
      size: 999,
      idleTranslucent: false,
      expanded: true,
      lastPosition: { x: 12, y: 34 },
      secret: 'do-not-export',
    } as never);

    expect(normalized).toEqual({
      ...DEFAULT_PET_CONFIG,
      enabled: true,
      size: 120,
      idleTranslucent: false,
      expanded: true,
      lastPosition: { x: 12, y: 34 },
    });
    expect(normalized).not.toHaveProperty('secret');
  });
});
