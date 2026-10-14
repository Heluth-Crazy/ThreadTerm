import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyNativeEdit, type NativeEditor } from './nativeTextEdit';

/** A textarea stand-in with a native undo stack and optional command failure. */
function editor(value: string, selectionStart = value.length, selectionEnd = selectionStart, mode: 'ok' | 'false' | 'throw' = 'ok') {
  const undo: string[] = [];
  const field: NativeEditor & { undone: string[] } = {
    value,
    selectionStart,
    selectionEnd,
    undone: undo,
    focus() { /* focus is a no-op in the stand-in */ },
    setSelectionRange(start: number, end: number) { field.selectionStart = start; field.selectionEnd = end; },
  };
  const execCommand = (command: 'insertText' | 'delete', _showUI: boolean, insert: string) => {
    if (mode === 'throw') throw new Error('execCommand unavailable');
    if (mode === 'false') return false;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    undo.push(field.value);
    field.value = command === 'insertText' ? `${field.value.slice(0, start)}${insert}${field.value.slice(end)}` : `${field.value.slice(0, start)}${field.value.slice(end)}`;
    field.selectionStart = field.selectionEnd = command === 'insertText' ? start + insert.length : start;
    return true;
  };
  return { field, execCommand };
}

test('the native command edits the DOM and mirrors it synchronously', () => {
  const { field, execCommand } = editor('see @car', 8, 8);
  const applied: string[] = [];
  let scheduled: (() => void) | undefined;
  const result = applyNativeEdit({
    area: field, start: 4, end: 8, insert: '@cart.ts ',
    allowed: () => true, apply: value => applied.push(value), execCommand,
    schedule: run => { scheduled = run; },
  });
  assert.deepEqual(result, { edited: true, fallback: false, caret: 13 });
  assert.equal(field.value, 'see @cart.ts ');
  assert.deepEqual(applied, ['see @cart.ts '], 'state mirrors the DOM synchronously');
  scheduled?.();
  assert.equal(field.selectionStart, 13);
  assert.equal(field.selectionEnd, 13);
  assert.equal(field.undone.length, 1, 'the edit joins the native undo stack');
});

test('the fallback keeps the edit when execCommand returns false or throws', () => {
  for (const mode of ['false', 'throw'] as const) {
    const { field, execCommand } = editor('a @x b', 6, 6, mode);
    const applied: string[] = [];
    const result = applyNativeEdit({
      area: field, start: 2, end: 4, insert: '@cart.ts ',
      allowed: () => true, apply: value => applied.push(value), execCommand, schedule: () => undefined,
    });
    assert.deepEqual(result, { edited: true, fallback: true, caret: 11 }, mode);
    assert.deepEqual(applied, ['a @cart.ts  b'], mode);
  }
});

test('a composing field or a failing guard makes the helper a no-op', () => {
  const { field, execCommand } = editor('@car', 4, 4);
  const applied: string[] = [];
  assert.deepEqual(applyNativeEdit({ area: field, start: 0, end: 4, insert: '@cart.ts ', blocked: true, allowed: () => true, apply: value => applied.push(value), execCommand }), { edited: false, fallback: false, caret: 0 });
  assert.deepEqual(applyNativeEdit({ area: field, start: 0, end: 4, insert: '@cart.ts ', allowed: () => false, apply: value => applied.push(value), execCommand }), { edited: false, fallback: false, caret: 0 });
  assert.deepEqual(applyNativeEdit({ area: null, start: 0, end: 0, insert: 'x', allowed: () => true, apply: value => applied.push(value), execCommand }), { edited: false, fallback: false, caret: 0 });
  assert.deepEqual(applied, []);
  assert.equal(field.value, '@car');
});

test('a delete replaces the whole mention range', () => {
  const { field, execCommand } = editor('see @cart.ts now', 13, 13);
  const applied: string[] = [];
  const result = applyNativeEdit({ area: field, start: 4, end: 12, insert: '', allowed: () => true, apply: value => applied.push(value), execCommand, schedule: () => undefined });
  assert.deepEqual(result, { edited: true, fallback: false, caret: 4 });
  assert.equal(field.value, 'see  now');
  assert.deepEqual(applied, ['see  now']);
});
