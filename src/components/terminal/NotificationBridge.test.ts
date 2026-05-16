import { describe, expect, it } from 'vitest';
import { shouldDispatchOsNotification } from './notificationDispatchMode';

describe('shouldDispatchOsNotification', () => {
  it('dispatches only system-capable desktop pet modes', () => {
    expect(shouldDispatchOsNotification('off')).toBe(false);
    expect(shouldDispatchOsNotification('pet')).toBe(false);
    expect(shouldDispatchOsNotification('system')).toBe(true);
    expect(shouldDispatchOsNotification('both')).toBe(true);
  });
});
