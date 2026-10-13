import assert from 'node:assert/strict';
import test from 'node:test';
import { nextMenuIndex } from './contextMenuActions';
import { listenForSteerMenuDismissal, type SteerMenuDismissReason } from './steerMenu';

function harness(inside = false) {
  const page = new EventTarget();
  const reasons: SteerMenuDismissReason[] = [];
  // The arrow is focused only when dismissal asks for it (Escape); an outside
  // pointer must leave focus where the user clicked.
  let focus = 'menu';
  const dispose = listenForSteerMenuDismissal(page, () => inside, reason => {
    reasons.push(reason);
    focus = reason === 'escape' ? 'arrow' : 'clicked';
  });
  return { page, reasons, dispose, focus: () => focus };
}

test('Escape closes the split-Send menu and returns focus to the arrow', () => {
  const h = harness();
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  h.page.dispatchEvent(escape);
  assert.deepEqual(h.reasons, ['escape']);
  assert.equal(h.focus(), 'arrow');
  assert.equal(escape.defaultPrevented, true);
  h.dispose();
});

test('an outside pointer-down closes without moving focus back to the arrow', () => {
  const h = harness();
  h.page.dispatchEvent(new Event('pointerdown'));
  assert.deepEqual(h.reasons, ['pointer']);
  assert.equal(h.focus(), 'clicked');
  h.dispose();
});

test('inside interactions and ordinary keys do not dismiss, and cleanup removes listeners', () => {
  const inside = harness(true);
  inside.page.dispatchEvent(new Event('pointerdown'));
  inside.page.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter' }));
  assert.deepEqual(inside.reasons, []);
  inside.dispose();
  inside.page.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
  assert.deepEqual(inside.reasons, []);
});

test('dismissal settles exactly once when a pointer and a key race', () => {
  const h = harness();
  h.page.dispatchEvent(new Event('pointerdown'));
  h.page.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
  assert.deepEqual(h.reasons, ['pointer']);
  h.dispose();
});

test('the menu keys wrap and stay put with a single item', () => {
  assert.equal(nextMenuIndex('ArrowDown', 0, 3), 1);
  assert.equal(nextMenuIndex('ArrowUp', 0, 3), 2);
  assert.equal(nextMenuIndex('Home', 2, 3), 0);
  assert.equal(nextMenuIndex('End', 0, 3), 2);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    assert.equal(nextMenuIndex(key, 0, 1), 0, key);
  }
});
