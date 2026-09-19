import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationPreferences, shouldShowNativeNotification } from '../src/notificationPreferences.js';

test('an existing native-only preference retains attention and completion delivery', () => {
  assert.deepEqual(notificationPreferences({ native: true }), { native: true, attention: true, completed: true, sound: false });
  assert.equal(shouldShowNativeNotification({ native: true }, 'attention'), true);
  assert.equal(shouldShowNativeNotification({ native: true }, 'completed'), true);
});

test('per-kind toggles filter delivery without changing explicit native consent', () => {
  const preferences = { native: true, attention: false, completed: true, sound: true };
  assert.equal(shouldShowNativeNotification(preferences, 'attention'), false);
  assert.equal(shouldShowNativeNotification(preferences, 'completed'), true);
  assert.equal(notificationPreferences(preferences).sound, true);
});

test('missing or disabled native consent never produces an OS notification', () => {
  assert.equal(shouldShowNativeNotification(undefined, 'attention'), false);
  assert.equal(shouldShowNativeNotification({ native: false, attention: true, completed: true }, 'completed'), false);
});
