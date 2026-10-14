import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mentionActionSnapshot,
  mentionActionStillValid,
  mentionContainingSelection,
  mentionMarkAtPoint,
  pointerMentionTarget,
  type MentionMark,
} from './mentionActions';
import type { ResolvedMention } from './inlineMentions';

const range = (start: number, end: number, token: string, itemId = token): ResolvedMention => ({ start, end, token, itemId });
const mark = (start: number, end: number, token: string, rects: MentionMark['rects']): MentionMark => ({ start, end, token, itemId: token, rects });

test('mentionMarkAtPoint hit-tests every wrapped fragment of a mark', () => {
  const wrapped = mark(10, 20, '@cart.ts', [
    { x: 0, y: 0, width: 40, height: 16 },
    { x: 0, y: 16, width: 20, height: 16 },
  ]);
  const other = mark(30, 40, '@checkout.ts', [{ x: 60, y: 0, width: 50, height: 16 }]);
  assert.equal(mentionMarkAtPoint([wrapped, other], 10, 8)?.token, '@cart.ts', 'first fragment');
  assert.equal(mentionMarkAtPoint([wrapped, other], 5, 20)?.token, '@cart.ts', 'second wrapped fragment');
  assert.equal(mentionMarkAtPoint([wrapped, other], 70, 8)?.token, '@checkout.ts');
  assert.equal(mentionMarkAtPoint([wrapped, other], 45, 8), undefined, 'gap between marks');
  assert.equal(mentionMarkAtPoint([wrapped, other], 100, 100), undefined, 'outside every rect');
});

test('mentionContainingSelection only matches a non-collapsed selection inside one range', () => {
  const a = range(0, 8, '@cart.ts');
  const b = range(9, 21, '@checkout.ts');
  assert.equal(mentionContainingSelection([a, b], 3, 8)?.token, '@cart.ts');
  assert.equal(mentionContainingSelection([a, b], 0, 8)?.token, '@cart.ts', 'exact range');
  assert.equal(mentionContainingSelection([a, b], 0, 21), undefined, 'spanning two ranges');
  assert.equal(mentionContainingSelection([a, b], 8, 8), undefined, 'collapsed caret is not a selection');
  assert.equal(mentionContainingSelection([a, b], 8, 12), undefined, 'starts past the range');
});

test('pointerMentionTarget acts on the mark under the pointer, selection or not', () => {
  const a = range(0, 8, '@cart.ts');
  const b = range(9, 21, '@checkout.ts');
  const marks = [mark(0, 8, '@cart.ts', [{ x: 0, y: 0, width: 40, height: 16 }]), mark(9, 21, '@checkout.ts', [{ x: 50, y: 0, width: 50, height: 16 }])];
  const wholeA = [{ x: 0, y: 0, width: 40, height: 16 }];
  // The selected part of `@cart.ts` from offset 3 to 10 (which runs past the token).
  const partial = [{ x: 12, y: 0, width: 40, height: 16 }];
  const base = { resolved: [a, b], marks, selectionRects: [] };
  // A caret anywhere does not decide a pointer target.
  assert.equal(pointerMentionTarget({ ...base, selectionStart: 8, selectionEnd: 8, x: 70, y: 8 })?.token, '@checkout.ts', 'caret on A, click B acts on B');
  assert.equal(pointerMentionTarget({ ...base, selectionStart: 8, selectionEnd: 8, x: 10, y: 8 })?.token, '@cart.ts', 'caret on A, click A acts on A');
  // A selection on A does not hijack a click on B; a click inside A's selection resolves A.
  assert.equal(pointerMentionTarget({ ...base, selectionStart: 0, selectionEnd: 8, selectionRects: wholeA, x: 70, y: 8 })?.token, '@checkout.ts', 'selection on A, click B acts on B');
  assert.equal(pointerMentionTarget({ ...base, selectionStart: 0, selectionEnd: 8, selectionRects: wholeA, x: 10, y: 8 })?.token, '@cart.ts', 'click inside A selection acts on A');
  // A selection wider than a token intentionally has no mention action only when the
  // pointer itself lies inside the selection.
  assert.equal(pointerMentionTarget({ ...base, selectionStart: 0, selectionEnd: 12, selectionRects: wholeA, x: 10, y: 8 }), undefined, 'selection spanning plain text yields no target');
  assert.equal(pointerMentionTarget({ ...base, selectionStart: 3, selectionEnd: 10, selectionRects: partial, x: 20, y: 8 }), undefined, 'a partial selection overlapping the token yields no target');
  assert.equal(pointerMentionTarget({ ...base, selectionStart: 3, selectionEnd: 10, selectionRects: partial, x: 10, y: 8 })?.token, '@cart.ts', 'the unselected part of a partially selected token still targets the token');
  // Pointer on plain text never falls back to the caret.
  assert.equal(pointerMentionTarget({ ...base, selectionStart: 3, selectionEnd: 3, x: 45, y: 8 }), undefined, 'plain text between tokens');
});

test('mentionActionStillValid revalidates same lifecycle, range and token', () => {
  const snapshot = mentionActionSnapshot(range(5, 13, '@cart.ts'), 'life');
  assert.equal(mentionActionStillValid(snapshot, { lifecycle: 'life', resolved: [range(5, 13, '@cart.ts')] }), true);
  assert.equal(mentionActionStillValid(snapshot, { lifecycle: 'other', resolved: [range(5, 13, '@cart.ts')] }), false, 'session switched');
  assert.equal(mentionActionStillValid(snapshot, { lifecycle: 'life', resolved: [range(6, 14, '@cart.ts')] }), false, 'range moved');
  assert.equal(mentionActionStillValid(snapshot, { lifecycle: 'life', resolved: [range(5, 13, '@other.ts')] }), false, 'token changed');
  assert.equal(mentionActionStillValid(snapshot, { lifecycle: 'life', resolved: [] }), false, 'token removed');
});
