import { describe, expect, it } from 'vitest';
import { DEFAULT_OS_NOTIFICATIONS_ENABLED, readOsNotificationsEnabled } from './notificationPrefs';

describe('readOsNotificationsEnabled', () => {
  it('reads the new boolean field when present', () => {
    expect(readOsNotificationsEnabled({ osNotificationsEnabled: true })).toBe(true);
    expect(readOsNotificationsEnabled({ osNotificationsEnabled: false })).toBe(false);
  });

  it('falls back to legacy petConfig.notificationMode (system/both → on)', () => {
    expect(readOsNotificationsEnabled({ petConfig: { notificationMode: 'both' } })).toBe(true);
    expect(readOsNotificationsEnabled({ petConfig: { notificationMode: 'system' } })).toBe(true);
    expect(readOsNotificationsEnabled({ petConfig: { notificationMode: 'pet' } })).toBe(false);
    expect(readOsNotificationsEnabled({ petConfig: { notificationMode: 'off' } })).toBe(false);
  });

  it('prefers the new boolean over a legacy petConfig', () => {
    expect(
      readOsNotificationsEnabled({
        osNotificationsEnabled: false,
        petConfig: { notificationMode: 'both' },
      }),
    ).toBe(false);
  });

  it('defaults on for missing or unrecognised input', () => {
    expect(DEFAULT_OS_NOTIFICATIONS_ENABLED).toBe(true);
    expect(readOsNotificationsEnabled(null)).toBe(true);
    expect(readOsNotificationsEnabled({})).toBe(true);
    expect(readOsNotificationsEnabled({ petConfig: {} })).toBe(true);
  });
});
