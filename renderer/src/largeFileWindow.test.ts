import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWindowLoader, isLargeFileError, LARGE_FILE_WINDOW_BYTES as budget, percentOffset, windowOffset, type TextWindow, type WindowState } from './largeFileWindow';

const fixture = (start = 0, content = 'first', token = 'v1'): TextWindow => ({
  content, start, end: start + budget, size: 20 * 1024 * 1024, changeToken: token, startsMidLine: false, endsMidLine: false,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('large-file fallback recognizes project RPC wrappers and external error codes', () => {
  assert.equal(isLargeFileError({ code: 'invalid_request', message: 'file_too_large' }), true);
  assert.equal(isLargeFileError({ code: 'file_too_large', message: 'too large' }), true);
  assert.equal(isLargeFileError(Error('file_too_large')), true);
  assert.equal(isLargeFileError({ code: 'invalid_request', message: 'binary_file' }), false);
  assert.equal(isLargeFileError(Error('not_file_too_large')), false);
});

test('window navigation uses actual offsets and clamps start/end/percent', () => {
  const first = fixture();
  assert.equal(windowOffset(first, 'start'), 0);
  assert.equal(windowOffset(first, 'previous'), 0);
  assert.equal(windowOffset(first, 'next'), first.end);
  assert.equal(windowOffset(first, 'end'), first.size - budget);
  assert.equal(percentOffset(first.size, 50), first.size / 2);
  assert.equal(percentOffset(first.size, -1), 0);
  assert.equal(percentOffset(first.size, 110), first.size - budget);
  assert.equal(percentOffset(10, 100), 0);
});

test('only latest response is published and unmount fences pending reads', async () => {
  const a = deferred<TextWindow>(), b = deferred<TextWindow>();
  const states: WindowState[] = [];
  const loader = createWindowLoader(offset => offset ? b.promise : a.promise, state => states.push(state));
  const first = loader.load(0), next = loader.load(budget);
  b.resolve(fixture(budget, 'second'));
  await next;
  a.resolve(fixture(0, 'obsolete'));
  await first;
  assert.equal(states.at(-1)?.window?.content, 'second');
  const count = states.length;
  const pending = loader.load(0);
  loader.dispose();
  await pending;
  assert.equal(states.length, count + 1); // loading only, no reply after disposal
});

test('file change drops old text and reload omits the previous token', async () => {
  const tokens: Array<string | undefined> = [];
  const states: WindowState[] = [];
  let call = 0;
  const loader = createWindowLoader(async (_offset, token) => {
    tokens.push(token);
    if (++call === 2) throw Object.assign(new Error('file_changed'), { code: 'file_changed' });
    return fixture(0, call === 1 ? 'old' : 'fresh', call === 1 ? 'v1' : 'v2');
  }, state => states.push(state));
  await loader.load(0);
  await loader.load(budget);
  assert.equal(states.at(-1)?.window, undefined);
  assert.equal(states.at(-1)?.busy, false);
  assert.match(String(states.at(-1)?.error), /file_changed/);
  await loader.load(0, true);
  assert.deepEqual(tokens, [undefined, 'v1', undefined]);
  assert.equal(states.at(-1)?.window?.content, 'fresh');
});

test('binary and missing read errors remove resident text', async () => {
  for (const code of ['binary_file', 'file_not_found', 'external_file_not_found']) {
    let state!: WindowState, calls = 0;
    const loader = createWindowLoader(async () => { if (calls++) throw Error(code); return fixture(); }, next => { state = next; });
    await loader.load(0);
    assert.ok(state.window);
    await loader.load(budget);
    assert.equal(state.window, undefined);
    assert.equal(state.busy, false);
    assert.match(String(state.error), new RegExp(code));
  }
});

test('navigation replaces one resident response without retaining history', async () => {
  let state!: WindowState;
  const loader = createWindowLoader(async offset => fixture(offset, 'x'.repeat(budget)), next => { state = next; });
  for (let index = 0; index < 50; index++) {
    await loader.load(index * budget);
    assert.equal(state.window?.content.length, budget);
    assert.equal(state.window?.start, index * budget);
    assert.deepEqual(Object.keys(state).sort(), ['busy', 'window']);
  }
});
