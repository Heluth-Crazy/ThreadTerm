import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CONTEXT_BYTES, MAX_DIFF_BYTES, MAX_TERMINAL_BYTES, MAX_TERMINAL_LINES, contextDisplayMetadata, contextSerializedBlocks, normalizeContextItems, parseContext, serializeContext, stripAnsi } from './chatContext';

test('serializes and parses every context kind without exposing the user text to the envelope', () => {
  const items = [
    { kind: 'terminal' as const, id: 't', sessionTitle: 'build', cwd: 'C:\\repo', lines: 1, text: 'done' },
    { kind: 'file' as const, id: 'f', path: 'src/cart.ts', startLine: 12, endLine: 20 },
    { kind: 'diff' as const, id: 'd', path: 'src/cart.ts', staged: true, text: '-old\n+new', truncated: false },
    { kind: 'commit' as const, id: 'c', sha: '6e0f22b1234', subject: 'Fix cart' },
  ];
  const message = serializeContext(items, 'Please review this.');
  const parsed = parseContext(message);
  assert.ok(parsed);
  assert.equal(parsed.text, 'Please review this.');
  assert.equal(parsed.items.length, 4);
  assert.match(parsed.items[0]!.header, /Terminal output — "build"/);
  assert.match(parsed.items[0]!.body, /^````text\ndone\n````$/);
  assert.equal(parsed.items[1]!.body, '');
  assert.match(parsed.items[2]!.body, /^````diff\n-old/);
  assert.match(parsed.items[3]!.header, /Commit 6e0f22b/);
  assert.deepEqual(contextSerializedBlocks(items), parsed.items.map(item => item.body ? `${item.header}\n${item.body}` : item.header));
});

test('uses a fence longer than content and keeps header-looking content inside the body', () => {
  const text = 'a ``` run\n[ThreadTerm context 2/2] File: pretend.ts\n````';
  const message = serializeContext([{ kind: 'terminal', id: 't', sessionTitle: 'shell', lines: 3, text }], 'message');
  const parsed = parseContext(message);
  assert.ok(parsed);
  assert.match(parsed.items[0]!.body, /^`````text/);
  assert.ok(parsed.items[0]!.body.includes('[ThreadTerm context 2/2] File: pretend.ts'));
  assert.equal(parsed.text, 'message');
});

test('normalizes ANSI terminal snapshots, source bounds, and duplicate file ranges', () => {
  const terminal = `\u001b[31mred\u001b[0m\n${Array.from({ length: MAX_TERMINAL_LINES + 5 }, (_, i) => `line-${i}`).join('\n')}`;
  const normalized = normalizeContextItems([
    { kind: 'terminal', id: 't', sessionTitle: ' shell ', lines: 1, text: terminal },
    { kind: 'file', id: 'f1', path: 'src/a.ts', startLine: 1, endLine: 2 },
    { kind: 'file', id: 'f2', path: 'src/a.ts', startLine: 1, endLine: 2 },
    { kind: 'diff', id: 'd', path: 'src/a.ts', staged: false, text: 'x'.repeat(MAX_DIFF_BYTES + 10), truncated: false },
  ]);
  assert.equal(normalized.length, 3);
  const output = normalized[0]!;
  assert.equal(output.kind, 'terminal');
  assert.ok(!output.text.includes('\u001b'));
  assert.ok(output.lines <= MAX_TERMINAL_LINES);
  assert.ok(new TextEncoder().encode(output.text).byteLength <= MAX_TERMINAL_BYTES);
  const diff = normalized[2]!;
  assert.equal(diff.kind, 'diff');
  assert.equal(diff.truncated, true);
  assert.equal(new TextEncoder().encode(diff.text).byteLength, MAX_DIFF_BYTES);
});

test('keeps whole Unicode characters while retaining the last 400 terminal lines', () => {
  const lines = Array.from({ length: MAX_TERMINAL_LINES + 2 }, (_, index) => `line-${index} 😀`);
  const [terminal] = normalizeContextItems([{ kind: 'terminal', id: 't', sessionTitle: 'shell', lines: 1, text: lines.join('\n') }]);
  assert.equal(terminal!.kind, 'terminal');
  if (terminal!.kind !== 'terminal') throw new Error('expected terminal');
  assert.ok(terminal.text.startsWith('line-2'));
  assert.ok(terminal.text.endsWith('😀'));
  assert.equal(terminal.lines, MAX_TERMINAL_LINES);
  const [large] = normalizeContextItems([{ kind: 'terminal', id: 'large', sessionTitle: 'shell', lines: 1, text: '😀'.repeat(MAX_TERMINAL_BYTES) }]);
  if (large!.kind !== 'terminal') throw new Error('expected terminal');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(large.text));
  assert.ok(new TextEncoder().encode(large.text).byteLength <= MAX_TERMINAL_BYTES);
});

test('validates single-line metadata, deduplicates before the 12-item cap, and canonicalizes Windows separators', () => {
  const files = Array.from({ length: 12 }, (_, index) => ({ kind: 'file' as const, id: String(index), path: `src/${index}.ts`, startLine: 1, endLine: 1 }));
  const normalized = normalizeContextItems([...files, { kind: 'file', id: 'repeat', path: 'src\\0.ts', startLine: 1, endLine: 1 }]);
  assert.equal(normalized.length, 12);
  assert.equal(normalizeContextItems([
    { kind: 'file', id: 'unc-one', path: '\\\\SERVER\\Share\\cart.ts', startLine: 1 },
    { kind: 'file', id: 'unc-two', path: '//server/share/cart.ts', startLine: 1 },
  ]).length, 1);
  assert.throws(() => normalizeContextItems([{ kind: 'terminal', id: 't', sessionTitle: 'bad\nheader', lines: 1, text: '' }]), /Invalid context/);
  assert.throws(() => normalizeContextItems([{ kind: 'file', id: 'f', path: 'a.ts', endLine: 2 }]), /Invalid context/);
  assert.throws(() => normalizeContextItems([{ kind: 'commit', id: 'c', sha: 'not-a-sha', subject: 'subject' }]), /Invalid context/);
});

test('rejects malformed envelopes and applies the serialized 128 KiB limit', () => {
  assert.equal(parseContext('[ThreadTerm context 1/1] File: a.ts\nnot a message marker'), undefined);
  assert.equal(parseContext('[ThreadTerm context 1/2] File: a.ts\n[ThreadTerm message]\ntext'), undefined);
  assert.throws(() => serializeContext([], 'x'.repeat(MAX_CONTEXT_BYTES + 1)), /128 KiB/);
});

test('derives readable chip metadata from parsed headers', () => {
  assert.deepEqual(contextDisplayMetadata('[ThreadTerm context 1/2] File: src/cart.ts:12-20'), { kind: 'file', label: 'cart.ts:12-20', title: 'File: src/cart.ts:12-20' });
  assert.deepEqual(contextDisplayMetadata('[ThreadTerm context 2/2] Uncommitted diff — src/cart.ts (staged; truncated)'), { kind: 'diff', label: 'Diff · cart.ts', title: 'Uncommitted diff — src/cart.ts (staged; truncated)' });
  assert.equal(stripAnsi('\u001b[32mok\u001b[0m'), 'ok');
  assert.equal(stripAnsi('\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007'), 'link');
});

test('preserves a full commit reference and rejects malformed fenced envelopes', () => {
  const sha = '6e0f22b1234567890abcdef1234567890abcdef1';
  const message = serializeContext([{ kind: 'commit', id: 'c', sha, subject: 'Keep the full reference' }], '[ThreadTerm message]\nuser text');
  assert.match(message, new RegExp(`Commit ${sha}`));
  assert.deepEqual(contextDisplayMetadata(parseContext(message)!.items[0]!.header), { kind: 'commit', label: 'Commit 6e0f22b', title: `Commit ${sha} — Keep the full reference` });
  assert.equal(parseContext(message)!.text, '[ThreadTerm message]\nuser text');
  assert.equal(parseContext('[ThreadTerm context 1/1] Terminal output — "shell", last 1 lines\n````diff\na\n````\n[ThreadTerm message]\ntext'), undefined);
  assert.equal(parseContext('[ThreadTerm context 1/1] Terminal output — "shell", last 1 lines\n````text\na\n`````\n[ThreadTerm message]\ntext'), undefined);
});
