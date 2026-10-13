import assert from 'node:assert/strict';
import test from 'node:test';
import { listenForStatusDismissal, type StatusDismissReason } from './statusPopover';

function harness() {
  const page = new EventTarget();
  const reasons: StatusDismissReason[] = [];
  let focus = 'dialog';
  const dispose = listenForStatusDismissal(page, () => false, reason => {
    reasons.push(reason);
    focus = reason === 'focus' ? 'outside' : 'chip';
  });
  return { page, reasons, dispose, blur: () => { focus = 'body'; }, focus: () => focus };
}

test('Escape closes the open popover after the consistency probe blurs focus onto body', () => {
  const h = harness();
  h.blur();
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  h.page.dispatchEvent(escape);
  assert.deepEqual(h.reasons, ['escape']);
  assert.equal(h.focus(), 'chip');
  assert.equal(escape.defaultPrevented, true);
  h.dispose();
});

test('outside pointer closes once and keeps default focus movement from overriding chip focus', () => {
  const h = harness();
  const pointer = new Event('pointerdown', { cancelable: true });
  h.page.dispatchEvent(pointer);
  h.page.dispatchEvent(new Event('focusin'));
  assert.deepEqual(h.reasons, ['pointer']);
  assert.equal(h.focus(), 'chip');
  assert.equal(pointer.defaultPrevented, true);
  h.dispose();
});

test('inside interactions do not dismiss, ordinary keys do not dismiss, cleanup removes listeners', () => {
  const page = new EventTarget();
  const reasons: StatusDismissReason[] = [];
  const dispose = listenForStatusDismissal(page, () => true, reason => reasons.push(reason));
  page.dispatchEvent(new Event('pointerdown'));
  page.dispatchEvent(new Event('focusin'));
  page.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter' }));
  assert.deepEqual(reasons, []);
  dispose();
  page.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.deepEqual(reasons, []);
});

test('keyboard focus can leave a popover without trapping it on the chip', () => {
  const h = harness();
  h.page.dispatchEvent(new Event('focusin'));
  assert.deepEqual(h.reasons, ['focus']);
  assert.equal(h.focus(), 'outside');
  h.dispose();
});
