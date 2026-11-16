import assert from 'node:assert/strict';
import test from 'node:test';
import { referenceLocationTarget, selectedTerminalFileReference } from './referenceLocation';

test('reference locations retain source session and strip display positions without URL decoding', () => {
  for (const [input, path] of [
    ['D:\\repo\\src\\app.ts:42:3', 'D:\\repo\\src\\app.ts'],
    ['\\\\server\\share\\project\\app.ts:42', '\\\\server\\share\\project\\app.ts'],
    ['src/app.ts#L12C3', 'src/app.ts'],
    ['src/has%20space.ts:4', 'src/has%20space.ts'],
    ['D:/My Project/说明.md:8', 'D:/My Project/说明.md'],
  ]) assert.deepEqual(referenceLocationTarget('origin-session', { path: input }), { sessionId: 'origin-session', path });
});

test('no source session or unsafe reference never gains a location action', () => {
  assert.equal(referenceLocationTarget(undefined, { path: 'src/app.ts' }), undefined);
  for (const path of ['https://example.com/a.ts', 'javascript:alert(1)', 'src/a\n.ts', 'a'.repeat(16385)]) {
    assert.equal(referenceLocationTarget('s', { path }), undefined);
  }
  assert.equal(referenceLocationTarget('s\0', { path: 'src/app.ts' }), undefined);
});

test('structured extensionless paths remain literal and existing line metadata does not alter the path', () => {
  assert.deepEqual(referenceLocationTarget('s', { path: 'BUILD', line: 9, column: 2 }), { sessionId: 's', path: 'BUILD' });
  assert.deepEqual(referenceLocationTarget('s', { path: 'src/file.ts', line: 9 }), { sessionId: 's', path: 'src/file.ts' });
});

test('terminal keyboard selection is a complete local reference and not multiple output lines', () => {
  assert.deepEqual(selectedTerminalFileReference('D:/repo/app.ts:10:2'), { path: 'D:/repo/app.ts', line: 10, column: 2 });
  assert.deepEqual(selectedTerminalFileReference('\\\\server\\share\\app.ts:3'), { path: '\\\\server\\share\\app.ts', line: 3 });
  assert.equal(selectedTerminalFileReference('src/a.ts\nsrc/b.ts'), undefined);
  assert.equal(selectedTerminalFileReference('https://example.com/app.ts'), undefined);
  assert.equal(selectedTerminalFileReference(''), undefined);
});
