import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextItem } from './chatContext';
import {
  MAX_MENTION_CATALOGUE,
  activeMentionEntries,
  addMentionEntry,
  contextIdentityBudget,
  contextIdentityKey,
  deletionRange,
  highlightSegments,
  inlineMentionToken,
  isValidMentionToken,
  mentionAtCaret,
  mentionLabelForItem,
  resolveMentions,
  validateMentionCatalogue,
  type MentionEntry,
  type MentionableItem,
  type ResolvedMention,
} from './inlineMentions';

const file = (path: string, extra: Partial<Extract<MentionableItem, { kind: 'file' }>> = {}): MentionableItem => ({ kind: 'file', id: `file:${path}`, path, ...extra });
const session = (id: string, title: string): MentionableItem => ({ kind: 'session', id: `session:${id}`, sessionId: id, title, provider: 'claude' });
const commit = (sha: string): MentionableItem => ({ kind: 'commit', id: `commit:${sha}`, sha, subject: 'subject' });
const agent = (provider: string): MentionableItem => ({ kind: 'agent', id: `agent:${provider}`, provider });
const skill = (name: string): MentionableItem => ({ kind: 'skill', id: `skill:${name}`, name, invocation: `/${name}` });
const entry = (token: string, item: MentionableItem): MentionEntry => ({ token, item });

test('isValidMentionToken accepts bare and quoted tokens and rejects malformed ones', () => {
  assert.equal(isValidMentionToken('@cart.ts'), true);
  assert.equal(isValidMentionToken('@src/cart.ts'), true);
  assert.equal(isValidMentionToken('@cart.ts~2'), true);
  assert.equal(isValidMentionToken('@@'), true);
  assert.equal(isValidMentionToken('@"src/with space.ts"'), true);
  assert.equal(isValidMentionToken('@"a. b"'), true);
  assert.equal(isValidMentionToken(`@${'a'.repeat(63)}`), true);
  assert.equal(isValidMentionToken(`@${'a'.repeat(64)}`), false);
  for (const bad of ['', '@', 'cart.ts', '@a.', '@a,', '@a;', '@a:', '@a!', '@a?', '@a)', '@a]', '@a}', "@a'", '@a b', '@a\tb', '@a\nb', '@a\rb', '@"a', '@"a"b', '@""', '@"a\nb"']) {
    assert.equal(isValidMentionToken(bad), false, `expected ${JSON.stringify(bad)} to be invalid`);
  }
});

test('contextIdentityKey covers every kind and normalizes file paths', () => {
  assert.equal(contextIdentityKey(file('src/cart.ts')), 'file:src/cart.ts');
  assert.equal(contextIdentityKey(file('src\\cart.ts')), 'file:src/cart.ts');
  assert.equal(contextIdentityKey(file('src/cart.ts', { startLine: 4, endLine: 9 })), 'file:src/cart.ts#L4-9');
  assert.equal(contextIdentityKey(file('src/cart.ts', { startLine: 4 })), 'file:src/cart.ts#L4-4');
  assert.equal(contextIdentityKey(session('abc', 'Chat')), 'session:abc');
  assert.equal(contextIdentityKey(commit('6E0F22B1234')), 'commit:6e0f22b1234');
  assert.equal(contextIdentityKey(agent('Pi')), 'agent:Pi');
  assert.equal(contextIdentityKey(skill('review')), 'skill:review');
  assert.equal(contextIdentityKey({ kind: 'terminal', id: 'term-1', sessionTitle: 's', lines: 1, text: '' }), 'term-1');
});

test('identity keys let a mention and a file-view attachment of the same path agree', () => {
  const mention = file('src/cart.ts');
  const attachment: ContextItem = { kind: 'file', id: 'random-42', path: 'src\\cart.ts' };
  assert.equal(contextIdentityKey(mention), contextIdentityKey(attachment));
  // An absolute path inside the workspace collapses to the same relative key.
  assert.equal(contextIdentityKey(file('C:\\repo\\src\\cart.ts'), 'C:\\repo'), 'file:src/cart.ts');
  assert.equal(contextIdentityKey(file('c:/repo/src/cart.ts'), 'C:/Repo'), 'file:src/cart.ts');
  // Outside the workspace the normalized absolute path stays.
  assert.equal(contextIdentityKey(file('D:/other/cart.ts'), 'C:/repo'), 'file:d:/other/cart.ts');
});

test('labels per kind keep a directory slash and fall back sensibly', () => {
  assert.equal(mentionLabelForItem(file('src/components/button.tsx')), 'button.tsx');
  assert.equal(mentionLabelForItem(file('src/components/')), 'components/');
  assert.equal(mentionLabelForItem(file('src\\components\\')), 'components/');
  assert.equal(mentionLabelForItem(session('s', 'Other chat')), 'Other chat');
  assert.equal(mentionLabelForItem(commit('6E0F22B1234567')), '6e0f22b');
  assert.equal(mentionLabelForItem(agent('Codex')), 'codex');
  assert.equal(mentionLabelForItem(skill('review')), 'review');
});

test('inlineMentionToken reuses the identity token and quotes when required', () => {
  const item = file('src/cart.ts');
  const catalogue = [entry('@cart.ts', item)];
  assert.equal(inlineMentionToken(item, catalogue), '@cart.ts');
  assert.equal(inlineMentionToken(session('s', 'Other chat'), []), '@"Other chat"');
  assert.equal(inlineMentionToken(file('src/cart.ts'), []), '@cart.ts');
  assert.equal(inlineMentionToken(file('src/a b.ts'), []), '@"a b.ts"');
  assert.equal(inlineMentionToken(file('src/a."b".ts'), []), '@"a.\'b\'.ts"');
});

test('labels are bounded to 40 units without splitting a surrogate pair', () => {
  const long = inlineMentionToken(session('s', 'x'.repeat(80)), []);
  assert.equal(long, `@"${'x'.repeat(39)}…"`);
  const emoji = inlineMentionToken(session('s', 'a'.repeat(38) + '😀😀'), []);
  assert.ok(emoji.endsWith('…"') || emoji.endsWith('…'), emoji);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji), emoji);
  const cjk = inlineMentionToken(session('s', '中'.repeat(60)), []);
  assert.ok(cjk.length <= 64);
  assert.ok(cjk.startsWith('@"中'), cjk);
});

test('kind fallbacks and the deterministic suffix loop avoid collisions', () => {
  // File: base basename taken, the workspace-relative fallback is the second candidate.
  assert.equal(inlineMentionToken(file('src/cart.ts'), [entry('@cart.ts', skill('other'))]), '@src/cart.ts');
  // Third and later collisions keep counting inside the same quoted form.
  const taken = [entry('@cart.ts', skill('one')), entry('@src/cart.ts', skill('two')), entry('@cart.ts~2', skill('three'))];
  assert.equal(inlineMentionToken(file('src/cart.ts'), taken), '@cart.ts~3');
  // Cross-kind collision with no fallback: the agent token yields to the skill suffix.
  assert.equal(inlineMentionToken(skill('pi'), [entry('@pi', agent('pi'))]), '@pi~2');
  // Session fallback adds the id prefix when the title collides.
  const sessions = [entry('@"Other chat"', session('abc123', 'Other chat'))];
  assert.equal(inlineMentionToken(session('abc999', 'Other chat'), sessions), '@"Other chat (abc999)"');
  // Commit fallback is the 12-char sha.
  assert.equal(inlineMentionToken(commit('6e0f22b1234aaaa'), [entry('@6e0f22b', skill('x'))]), '@6e0f22b1234a');
  // A reserved non-live token is never reused.
  assert.equal(inlineMentionToken(file('src/cart.ts'), [entry('@cart.ts', skill('ghost'))]), '@src/cart.ts');
});

test('addMentionEntry reuses identities and rejects a 65th identity without eviction', () => {
  const item = file('src/cart.ts');
  const first = addMentionEntry([], item);
  assert.ok('token' in first && first.token === '@cart.ts');
  const again = addMentionEntry(first.catalogue, item);
  assert.ok('token' in again && again.token === '@cart.ts' && again.catalogue.length === 1);
  const full: MentionEntry[] = Array.from({ length: MAX_MENTION_CATALOGUE }, (_, index) => entry(`@s${index}`, skill(`s${index}`)));
  assert.deepEqual(addMentionEntry(full, skill('brand-new')), { error: 'capacity' });
  // Existing identities still resolve to their original tokens at capacity.
  const existing = addMentionEntry(full, skill('s7'));
  assert.ok('token' in existing && existing.token === '@s7');
});

test('validateMentionCatalogue drops invalid entries and keeps first duplicates', () => {
  const valid = [
    entry('@cart.ts', file('src/cart.ts')),
    entry('@other', session('s', 'Other')),
    entry('@abc1234', commit('abc1234567')),
    entry('@codex', agent('codex')),
    entry('@review', skill('review')),
  ];
  assert.deepEqual(validateMentionCatalogue(valid), valid);
  const mixed = [
    entry('@cart.ts', file('src/cart.ts')),
    entry('@cart.ts', file('src/other.ts')), // duplicate token -> dropped
    entry('@dup', file('src/cart.ts')), // duplicate identity -> dropped
    { token: 'nope', item: file('src/x.ts') } as MentionEntry, // bad token
    { token: '@term', item: { kind: 'terminal', id: 't', sessionTitle: 's', lines: 1, text: '' } as ContextItem } as MentionEntry, // non-mentionable
    { token: '@bad', item: { kind: 'file', id: 'f' } } as MentionEntry, // malformed item
    'not-an-entry' as unknown as MentionEntry,
  ];
  assert.deepEqual(validateMentionCatalogue(mixed), [entry('@cart.ts', file('src/cart.ts'))]);
  assert.deepEqual(validateMentionCatalogue('nope'), []);
  // A 13-entry catalogue is not subject to the 12-tray cap.
  const thirteen = Array.from({ length: 13 }, (_, index) => entry(`@s${index}`, skill(`s${index}`)));
  assert.equal(validateMentionCatalogue(thirteen).length, 13);
  // Over 64 is truncated deterministically to the first 64.
  const many = Array.from({ length: 70 }, (_, index) => entry(`@s${index}`, skill(`s${index}`)));
  assert.equal(validateMentionCatalogue(many).length, MAX_MENTION_CATALOGUE);
});

test('resolveMentions honors ASCII, full-width and CJK boundaries on both sides', () => {
  const catalogue = [entry('@cart.ts', file('src/cart.ts'))];
  const at = (text: string) => resolveMentions(text, catalogue).map(range => [range.start, range.end]);
  assert.deepEqual(at('@cart.ts'), [[0, 8]]);
  assert.deepEqual(at('see @cart.ts'), [[4, 12]]);
  assert.deepEqual(at('see @cart.ts here'), [[4, 12]]);
  assert.deepEqual(at('中文@cart.ts'), [[2, 10]]);
  assert.deepEqual(at('@cart.ts中文'), [[0, 8]]);
  assert.deepEqual(at('请看@cart.ts。'), [[2, 10]]);
  assert.deepEqual(at('见（@cart.ts）'), [[2, 10]]);
  assert.deepEqual(at('@cartx'), []);
  assert.deepEqual(at('x@cart.ts'), []);
  assert.deepEqual(at('@cart.tsx'), []);
});

test('resolveMentions keeps the longer token on overlap and every occurrence', () => {
  const catalogue = [entry('@a', skill('a')), entry('@a.ts', file('src/a.ts'))];
  assert.deepEqual(resolveMentions('see @a.ts', catalogue).map(range => range.token), ['@a.ts']);
  assert.deepEqual(resolveMentions('@a @a', [entry('@a', skill('a'))]).map(range => range.start), [0, 3]);
  assert.deepEqual(resolveMentions('quoted @"Other chat" ok', [entry('@"Other chat"', session('s', 'Other chat'))]).map(range => range.token), ['@"Other chat"']);
});

test('active entries, caret lookup and deletion ranges follow the resolved set', () => {
  const a = entry('@a', skill('a'));
  const b = entry('@b.ts', file('src/b.ts'));
  const resolved = resolveMentions('@a and @b.ts', [a, b]);
  assert.deepEqual(activeMentionEntries([a, b], resolved), [a, b]);
  assert.deepEqual(activeMentionEntries([a, b], resolveMentions('plain', [a, b])), []);
  assert.equal(mentionAtCaret(resolved, 0), undefined);
  assert.equal(mentionAtCaret(resolved, 1)?.token, '@a');
  assert.equal(mentionAtCaret(resolved, 2)?.token, '@a');
  assert.equal(mentionAtCaret(resolved, 3), undefined);
  const first: ResolvedMention = { start: 0, end: 2, token: '@a', itemId: 'a' };
  const second: ResolvedMention = { start: 4, end: 9, token: '@b.ts', itemId: 'b' };
  assert.deepEqual(deletionRange([first, second], 1, 'Backspace'), { start: 0, end: 2 });
  assert.deepEqual(deletionRange([first, second], 0, 'Backspace'), undefined);
  assert.deepEqual(deletionRange([first, second], 2, 'Backspace'), { start: 0, end: 2 });
  assert.deepEqual(deletionRange([first, second], 2, 'Delete'), undefined);
  assert.deepEqual(deletionRange([first, second], 4, 'Delete'), { start: 4, end: 9 });
  assert.deepEqual(deletionRange([first, second], 9, 'Delete'), undefined);
  assert.deepEqual(deletionRange([first, second], 10, 'Backspace'), undefined);
});

test('highlightSegments round-trips the text and marks only resolved ranges', () => {
  const catalogue = [entry('@cart.ts', file('src/cart.ts'))];
  for (const text of ['', 'plain', 'see @cart.ts', '@cart.ts中文', 'a @cart.ts b @cart.ts']) {
    const segments = highlightSegments(text, resolveMentions(text, catalogue));
    assert.equal(segments.map(segment => segment.text).join(''), text);
    for (const segment of segments) if (segment.mention) assert.equal(segment.text, '@cart.ts');
  }
  assert.deepEqual(highlightSegments('see @cart.ts!', resolveMentions('see @cart.ts!', catalogue)).map(segment => Boolean(segment.mention)), [false, true, false]);
});

test('contextIdentityBudget counts unique tray and mention identities', () => {
  const tray: ContextItem[] = [
    { kind: 'file', id: 'random', path: 'src/cart.ts' },
    { kind: 'terminal', id: 'term', sessionTitle: 's', lines: 1, text: '' },
  ];
  const active = [entry('@cart.ts', file('src/cart.ts')), entry('@codex', agent('codex'))];
  assert.deepEqual(contextIdentityBudget(tray, active), { identities: 3, ok: true });
  const full = Array.from({ length: 11 }, (_, index) => entry(`@s${index}`, skill(`s${index}`)));
  assert.deepEqual(contextIdentityBudget(tray, full), { identities: 13, ok: false });
});
