import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeDelivery, notificationPreferences, shouldShowNativeNotification } from '../src/notificationPreferences.js';

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

test('session events reach the OS only with consent, their kind switched on, and ThreadTerm in the background', () => {
  const on = { native: true, attention: true, completed: false, sound: true };
  assert.deepEqual(nativeDelivery(on, 'attention', { appFocused: false }), { deliver: true, silent: false });
  assert.deepEqual(nativeDelivery(on, 'attention', { appFocused: true }), { deliver: false, reason: 'app-focused' });
  assert.deepEqual(nativeDelivery(on, 'completed', { appFocused: false }), { deliver: false, reason: 'kind-disabled' });
  assert.deepEqual(nativeDelivery({ native: false }, 'attention', { appFocused: false }), { deliver: false, reason: 'disabled' });
  assert.deepEqual(nativeDelivery({ native: true }, 'completed', { appFocused: false }), { deliver: true, silent: true });
});

test('a Settings test needs consent only, never the kind or focus rules', () => {
  assert.deepEqual(nativeDelivery({ native: true, attention: false }, 'attention', { appFocused: true, test: true }), { deliver: true, silent: true });
  assert.deepEqual(nativeDelivery(undefined, 'attention', { appFocused: true, test: true }), { deliver: false, reason: 'disabled' });
});
