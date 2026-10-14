import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CONTEXT_BYTES, MAX_DIFF_BYTES, MAX_SESSION_SUMMARY_BYTES, MAX_TERMINAL_BYTES, MAX_TERMINAL_LINES, contextDisplayMetadata, contextSerializedBlocks, normalizeContextItems, parseContext, serializeContext, serializeMentionedContext, stripAnsi } from './chatContext';
import type { MentionEntry } from './inlineMentions';

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

test('round-trips session, agent and skill mentions and their chip metadata', () => {
  const items = [
    { kind: 'session' as const, id: 'session:x', sessionId: 'x-1', title: 'Other chat', provider: 'claude' },
    { kind: 'agent' as const, id: 'agent:pi', provider: 'pi' },
    { kind: 'skill' as const, id: 'skill:review', name: 'review', invocation: '/review' },
  ];
  const message = serializeContext(items, 'please handle it');
  const parsed = parseContext(message)!;
  assert.ok(parsed);
  assert.equal(parsed.items.length, 3);
  assert.match(parsed.items[0]!.header, /Call session_info with this id\.$/);
  assert.equal(parsed.items[0]!.body, '');
  assert.match(parsed.items[1]!.header, /delegate the following task to pi with delegate_start\.$/);
  assert.match(parsed.items[2]!.header, /invoke: \/review\)$/);
  assert.equal(parsed.text, 'please handle it');
  assert.deepEqual(contextDisplayMetadata(parsed.items[0]!.header), { kind: 'session', label: 'Session · Other chat', title: 'Session x-1: Other chat (claude). Call session_info with this id.' });
  assert.deepEqual(contextDisplayMetadata(parsed.items[1]!.header), { kind: 'agent', label: 'Agent · pi', title: 'Agent: delegate the following task to pi with delegate_start.' });
  assert.deepEqual(contextDisplayMetadata(parsed.items[2]!.header), { kind: 'skill', label: 'Skill · review', title: 'Skill: review (invoke: /review)' });
  const withSummary = serializeContext([{ ...items[0]!, summary: 'User: hi' }], 'x');
  const summaryParsed = parseContext(withSummary)!;
  assert.equal(summaryParsed.items[0]!.body, '````text\nUser: hi\n````');
  assert.match(summaryParsed.items[0]!.header, /Summary attached; session_info unavailable\.$/);
  assert.doesNotMatch(summaryParsed.items[0]!.header, /Call session_info/);
  assert.deepEqual(contextDisplayMetadata(summaryParsed.items[0]!.header), { kind: 'session', label: 'Session · Other chat', title: 'Session x-1: Other chat (claude). Summary attached; session_info unavailable.' });
});

test('skill invocation containing an invoke marker still round-trips to the right chip', () => {
  const item = { kind: 'skill' as const, id: 'skill:review', name: 'review', invocation: '/run (invoke: x' };
  const message = serializeContext([item], 'go');
  const parsed = parseContext(message)!;
  assert.equal(parsed.items[0]!.header, '[ThreadTerm context 1/1] Skill: review (invoke: /run (invoke: x)');
  assert.deepEqual(contextDisplayMetadata(parsed.items[0]!.header), { kind: 'skill', label: 'Skill · review', title: 'Skill: review (invoke: /run (invoke: x)' });
});

test('every serialized mention header is single-line and length-bounded', () => {
  const blocks = contextSerializedBlocks([
    { kind: 'terminal' as const, id: 't', sessionTitle: 'build', lines: 1, text: 'x' },
    { kind: 'file' as const, id: 'f', path: 'src/a.ts' },
    { kind: 'diff' as const, id: 'd', path: 'src/a.ts', staged: false, text: 'x', truncated: false },
    { kind: 'commit' as const, id: 'c', sha: '6e0f22b1234', subject: 'Fix' },
    { kind: 'conversation' as const, id: 'v', copiedAt: 'now', text: 'x' },
    { kind: 'quote' as const, id: 'q', sourceTitle: 'src', text: 'x' },
    { kind: 'session' as const, id: 's', sessionId: 'x', title: 'Other', provider: 'claude' },
    { kind: 'session' as const, id: 's2', sessionId: 'y', title: 'Other', provider: 'claude', summary: 'User: hi' },
    { kind: 'agent' as const, id: 'a', provider: 'pi' },
    { kind: 'skill' as const, id: 'k', name: 'review', invocation: '/review' },
  ]);
  for (const block of blocks) {
    const header = block.split('\n', 1)[0]!;
    assert.ok(!/[\r\n]/.test(header), `header must be one line: ${JSON.stringify(header)}`);
    assert.ok(header.length <= 4096 * 3 + 64, `header must stay bounded: ${header.length}`);
  }
  // Metadata fields reject CR/LF outright, so no header can be split.
  for (const bad of [
    { kind: 'terminal' as const, id: 't', sessionTitle: 'a\rb', lines: 1, text: '' },
    { kind: 'file' as const, id: 'f', path: 'src/a\rb.ts' },
    { kind: 'commit' as const, id: 'c', sha: '6e0f22b1234', subject: 'a\nb' },
    { kind: 'session' as const, id: 's', sessionId: 'x', title: 'a\nb', provider: 'claude' },
    { kind: 'session' as const, id: 's', sessionId: 'x', title: 'a\rb', provider: 'claude', summary: 'User: hi' },
    { kind: 'agent' as const, id: 'a', provider: 'a\nb' },
    { kind: 'skill' as const, id: 'k', name: 'a\nb', invocation: '/x' },
  ]) {
    assert.throws(() => normalizeContextItems([bad]), /Invalid context/);
  }
});

test('rejects malformed mention kinds and still parses legacy envelopes', () => {
  assert.throws(() => normalizeContextItems([{ kind: 'session', id: 's', sessionId: 'bad id', title: 't', provider: 'p' }]), /Invalid context/);
  assert.throws(() => normalizeContextItems([{ kind: 'session', id: 's', sessionId: 'ok', title: 't', provider: 'bad provider' }]), /Invalid context/);
  assert.throws(() => normalizeContextItems([{ kind: 'agent', id: 'a', provider: 'bad provider' }]), /Invalid context/);
  assert.throws(() => normalizeContextItems([{ kind: 'skill', id: 'k', name: '', invocation: '/x' }]), /Invalid context/);
  assert.throws(() => normalizeContextItems([{ kind: 'session', id: 's', sessionId: 'ok', title: 't', provider: 'p', summary: 'x'.repeat(MAX_SESSION_SUMMARY_BYTES + 1) }]), /Invalid context/);
  // A prompt written before mentions existed still parses unchanged.
  const legacy = serializeContext([{ kind: 'file', id: 'f', path: 'src/cart.ts' }], 'legacy text');
  const parsed = parseContext(legacy)!;
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.text, 'legacy text');
});

test('a v1 mentions header maps tokens to block indexes and exposes inlineToken', () => {
  const active: MentionEntry[] = [
    { token: '@cart.ts', item: { kind: 'file', id: 'file:src/cart.ts', path: 'src/cart.ts' } },
    { token: '@codex', item: { kind: 'agent', id: 'agent:codex', provider: 'codex' } },
  ];
  const message = serializeMentionedContext({ trayItems: [], active }, 'Please ask @codex to review @cart.ts.');
  assert.match(message, /\[ThreadTerm message; mentions v1 \{"@cart\.ts":1,"@codex":2\}\]/);
  const parsed = parseContext(message)!;
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0]!.inlineToken, '@cart.ts');
  assert.equal(parsed.items[1]!.inlineToken, '@codex');
  assert.equal(parsed.text, 'Please ask @codex to review @cart.ts.');
  // Legacy messages cannot acquire the new meaning.
  const older = parseContext(serializeContext(active.map(entry => entry.item), 'see @cart.ts'))!;
  assert.equal(older.items[0]!.inlineToken, undefined);
});

test('one block per identity: a tray attachment and a mention share the block (tray data wins)', () => {
  const trayItem = { kind: 'file' as const, id: 'random-42', path: 'src\\cart.ts' };
  const mention = { kind: 'file' as const, id: 'file:src/cart.ts', path: 'src/cart.ts' };
  const message = serializeMentionedContext({ trayItems: [trayItem], active: [{ token: '@cart.ts', item: mention }] }, 'see @cart.ts');
  const parsed = parseContext(message)!;
  assert.equal(parsed.items.length, 1);
  assert.match(parsed.items[0]!.header, /File: src\\cart\.ts$/);
  assert.equal(parsed.items[0]!.inlineToken, '@cart.ts');
  assert.match(message, /mentions v1 \{"@cart\.ts":1\}/);
});

test('a legacy commit subject ending in an inline marker keeps its legacy meaning', () => {
  const message = serializeContext([{ kind: 'commit', id: 'c', sha: '6e0f22b1234', subject: 'Fix review (inline: @review)' }], 'text');
  const parsed = parseContext(message)!;
  assert.equal(parsed.items[0]!.inlineToken, undefined);
  assert.match(parsed.items[0]!.header, /\(inline: @review\)$/);
});

test('quoted tokens with parentheses and session summaries round-trip through the map', () => {
  const token = '@"Review (draft)"';
  const withSummary = { kind: 'session' as const, id: 's', sessionId: 's-1', title: 'Review (draft)', provider: 'claude', summary: 'User: hi' };
  const message = serializeMentionedContext({ trayItems: [], active: [{ token, item: withSummary }] }, `ask ${token}`);
  const parsed = parseContext(message)!;
  assert.equal(parsed.items[0]!.inlineToken, token);
  assert.match(parsed.items[0]!.body, /User: hi/);
  assert.match(parsed.items[0]!.header, /Summary attached; session_info unavailable\.$/);
});

test('malformed mention headers make the whole envelope fall back to plain text', () => {
  const block = contextSerializedBlocks([{ kind: 'file', id: 'f', path: 'src/cart.ts' }])[0]!;
  for (const header of [
    '[ThreadTerm message; mentions v1 {bad',
    '[ThreadTerm message; mentions v1 []',
    '[ThreadTerm message; mentions v1 {"@cart.ts":0}',
    '[ThreadTerm message; mentions v1 {"@cart.ts":2}',
    '[ThreadTerm message; mentions v1 {"@cart.ts":1,"@x":1}',
    '[ThreadTerm message; mentions v1 {"bad token":1}',
    '[ThreadTerm message; mentions v1 {"@a.":1}',
    '[ThreadTerm message] trailing',
  ]) {
    assert.equal(parseContext(`${block}\n${header}\ntext`), undefined, header);
  }
});

test('mention serialization enforces the 12-identity and 128 KiB budgets', () => {
  const active: MentionEntry[] = Array.from({ length: 13 }, (_, index) => ({ token: `@s${index}`, item: { kind: 'skill', id: `skill:s${index}`, name: `s${index}`, invocation: `/${index}` } }));
  assert.throws(() => serializeMentionedContext({ trayItems: [], active }, 'x'), /12 context items/);
  assert.throws(() => serializeMentionedContext({ trayItems: [], active: [] }, 'x'.repeat(MAX_CONTEXT_BYTES + 1)), /128 KiB/);
});
