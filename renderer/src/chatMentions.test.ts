import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem, GitCommitInfo, ProviderCapability, Session } from '@threadterm/protocol';
import { MAX_SESSION_SUMMARY_BYTES, agentMentionItems, beginMentionLoad, commitMentionItems, fileMentionItems, filterMentionItems, flatMentionItems, initialMentionLoadState, mentionAttachIsCurrent, mentionGroups, mentionKeyAction, mentionLoadCurrent, mentionLoadKey, mentionQuery, sessionContextItem, sessionMentionItems, sessionSummary, skillMentionItems } from './chatMentions';

function session(overrides: Partial<Session>): Session {
  return { id: 's', title: 'Session', provider: 'claude', mode: 'chat', status: 'idle', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides } as Session;
}

test('mentionQuery only fires at a word start and never inside an email', () => {
  assert.deepEqual(mentionQuery('see @cart', 9), { query: 'cart', start: 4, end: 9 });
  assert.deepEqual(mentionQuery('@', 1), { query: '', start: 0, end: 1 });
  assert.equal(mentionQuery('mail me a@b', 10), undefined);
  assert.equal(mentionQuery('@two words', 10), undefined);
  assert.equal(mentionQuery('see @cart', 3), undefined);
  assert.equal(mentionQuery('see @cart', 12), undefined);
  assert.equal(mentionQuery('no trigger', 4), undefined);
});

test('fileMentionItems lists files and their unique folders without duplicates', () => {
  const items = fileMentionItems(['src/cart.ts', 'src/checkout.ts', 'README.md', 'src/cart.ts']);
  assert.deepEqual(items.map(item => item.label), ['cart.ts', 'checkout.ts', 'README.md', 'src/']);
  const folder = items.find(item => item.label === 'src/')!;
  assert.equal(folder.item.kind, 'file');
  if (folder.item.kind !== 'file') throw new Error('expected file');
  assert.equal(folder.item.path, 'src/');
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
});

test('sessionMentionItems excludes the current session, terminals, and puts its project first', () => {
  const items = sessionMentionItems([
    session({ id: 'a', title: 'Other project', projectId: 'p2', updatedAt: '2026-02-01T00:00:00.000Z' }),
    session({ id: 'b', title: 'Same project old', projectId: 'p1', updatedAt: '2026-01-01T00:00:00.000Z' }),
    session({ id: 'c', title: 'Same project new', projectId: 'p1', updatedAt: '2026-03-01T00:00:00.000Z' }),
    session({ id: 't', title: 'A terminal', mode: 'terminal', projectId: 'p1', updatedAt: '2026-04-01T00:00:00.000Z' }),
    session({ id: 'self', title: 'Current', projectId: 'p1' }),
  ], 'self', 'p1');
  assert.deepEqual(items.map(item => item.label), ['Same project new', 'Same project old', 'Other project']);
  const first = items[0]!;
  assert.equal(first.item.kind, 'session');
  if (first.item.kind !== 'session') throw new Error('expected session');
  assert.equal(first.item.sessionId, 'c');
});

test('commitMentionItems keeps only well-formed hashes and subjects', () => {
  const commits = [
    { hash: '6e0f22b1234567890abcdef1234567890abcdef1', subject: 'Fix cart', authorName: 'A' },
    { hash: 'not-a-hash', subject: 'Bad', authorName: 'B' },
    { hash: 'abc1234', subject: 'Short ok', authorName: 'C' },
  ] as GitCommitInfo[];
  const items = commitMentionItems(commits);
  assert.deepEqual(items.map(item => item.label), ['6e0f22b Fix cart', 'abc1234 Short ok']);
});

test('agentMentionItems keeps installed chat providers other than the current one', () => {
  const capabilities = [
    { id: 'claude', name: 'Claude', installed: true, chat: true, terminal: false, history: false, resume: false },
    { id: 'codex', name: 'Codex', installed: false, chat: true, terminal: false, history: false, resume: false },
    { id: 'shell', name: 'Shell', installed: true, chat: false, terminal: true, history: false, resume: false },
  ] as ProviderCapability[];
  assert.deepEqual(agentMentionItems(capabilities, 'claude').map(item => item.label), []);
  assert.deepEqual(agentMentionItems([...capabilities, { id: 'pi', name: 'Pi', installed: true, chat: true, terminal: false, history: false, resume: false } as ProviderCapability], 'claude').map(item => item.label), ['Pi']);
});

test('skillMentionItems carries the provider invocation and drops malformed entries', () => {
  const items = skillMentionItems([
    { name: 'skill:review', description: 'Review code', invocation: '/skill:review' },
    { name: '/plan', invocation: '/plan' },
    { name: 'two words', invocation: '/two words' },
    { name: 'blank', invocation: '   ' },
    { name: 'multiline', invocation: '/multi\nline' },
  ]);
  assert.deepEqual(items.map(item => item.label), ['skill:review', 'plan']);
  const first = items[0]!;
  assert.equal(first.item.kind, 'skill');
  if (first.item.kind !== 'skill') throw new Error('expected skill');
  assert.equal(first.item.invocation, '/skill:review');
  assert.equal(first.item.name, 'skill:review');
});

test('mention loads restart on open or scope change and drop stale responses', () => {
  assert.equal(mentionLoadKey(undefined, 'w'), undefined);
  assert.equal(mentionLoadKey('p', undefined), 'p\u0000');
  assert.equal(mentionLoadKey('p', 'w'), 'p\u0000w');
  const closed = beginMentionLoad(initialMentionLoadState, false, 'p\u0000w');
  assert.equal(closed.ticket, undefined);
  const noProject = beginMentionLoad(initialMentionLoadState, true, undefined);
  assert.equal(noProject.ticket, undefined);
  const first = beginMentionLoad(initialMentionLoadState, true, 'p\u0000w');
  assert.deepEqual(first.ticket, { generation: 1, key: 'p\u0000w' });
  // One open on the same scope reuses the ticket (no redundant generation).
  assert.equal(beginMentionLoad(first, true, 'p\u0000w'), first);
  // A different project while open advances the generation and drops the old one.
  const second = beginMentionLoad(first, true, 'q\u0000w');
  assert.equal(second.ticket!.generation, 2);
  assert.equal(mentionLoadCurrent(first.ticket, second), false);
  assert.equal(mentionLoadCurrent(second.ticket, second), true);
  // Close then reopen on the same scope still advances the generation.
  const closedAgain = beginMentionLoad(second, false, 'q\u0000w');
  assert.equal(closedAgain.ticket, undefined);
  const third = beginMentionLoad(closedAgain, true, 'q\u0000w');
  assert.equal(third.ticket!.generation, 3);
  assert.equal(mentionLoadCurrent(second.ticket, third), false);
  assert.equal(mentionLoadCurrent(undefined, third), false);
});

test('filterMentionItems is case-insensitive and ranks prefix matches first', () => {
  const items = fileMentionItems(['src/cart.ts', 'src/cart-helper.ts', 'docs/cart.md']);
  assert.deepEqual(filterMentionItems(items, 'CART').map(item => item.label), ['cart.ts', 'cart-helper.ts', 'cart.md']);
  assert.deepEqual(filterMentionItems(items, 'helper').map(item => item.label), ['cart-helper.ts']);
  assert.deepEqual(filterMentionItems(items, '').map(item => item.label), ['cart.ts', 'cart-helper.ts', 'cart.md', 'src/', 'docs/']);
});

test('mentionGroups caps each group at eight, keeps totals, order and drops empty groups', () => {
  const files = fileMentionItems(Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts`));
  const groups = mentionGroups({ files, commits: commitMentionItems([]) }, '');
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.id, 'files');
  assert.equal(groups[0]!.items.length, 8);
  assert.equal(groups[0]!.total, 13);
  assert.equal(flatMentionItems(groups).length, 8);
  const narrowed = mentionGroups({ files }, 'file-1');
  assert.equal(narrowed[0]!.total, 3);
});

test('sessionSummary keeps role labels and caps at 16 KiB on a character boundary', () => {
  const items: ChatItem[] = [
    { id: 'u', role: 'user', createdAt: '', parts: [{ type: 'text', text: 'Hello' }] },
    { id: 'a', role: 'assistant', createdAt: '', parts: [{ type: 'text', text: 'Hi 😀' }] },
    { id: 't', role: 'tool', createdAt: '', parts: [{ type: 'text', text: 'ignored' }] },
  ];
  assert.equal(sessionSummary(items), 'User: Hello\n\nAssistant: Hi 😀');
  const long = sessionSummary([{ id: 'u', role: 'user', createdAt: '', parts: [{ type: 'text', text: '😀'.repeat(MAX_SESSION_SUMMARY_BYTES) }] }]);
  assert.ok(new TextEncoder().encode(long).byteLength <= MAX_SESSION_SUMMARY_BYTES);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(long));
});

test('sessionContextItem adds a bounded summary only when session-info is off', () => {
  const item = { kind: 'session' as const, id: 'session:x', sessionId: 'x', title: 'Other', provider: 'claude' };
  const items: ChatItem[] = [{ id: 'u', role: 'user', createdAt: '', parts: [{ type: 'text', text: 'Context' }] }];
  assert.deepEqual(sessionContextItem(item, items, true), item);
  assert.equal(sessionContextItem(item, items, false).summary, 'User: Context');
});

test('mentionAttachIsCurrent rejects a response after a session or lifecycle switch', () => {
  const lifecycle = { sessionId: 'a' };
  assert.equal(mentionAttachIsCurrent({ sessionId: 'a', lifecycle }, { sessionId: 'a', lifecycle }), true);
  assert.equal(mentionAttachIsCurrent({ sessionId: 'a', lifecycle }, { sessionId: 'b', lifecycle }), false);
  assert.equal(mentionAttachIsCurrent({ sessionId: 'a', lifecycle }, { sessionId: 'a', lifecycle: { sessionId: 'a' } }), false);
});

test('mentionKeyAction lets an IME own every key and never picks without rows', () => {
  assert.equal(mentionKeyAction('Enter', { count: 3 }), 'pick');
  assert.equal(mentionKeyAction('Enter', { count: 3, shiftKey: true }), undefined);
  assert.equal(mentionKeyAction('Tab', { count: 3 }), 'pick');
  assert.equal(mentionKeyAction('ArrowDown', { count: 3 }), 'next');
  assert.equal(mentionKeyAction('ArrowUp', { count: 3 }), 'previous');
  assert.equal(mentionKeyAction('Escape', { count: 3 }), 'close');
  assert.equal(mentionKeyAction('Escape', { count: 0 }), 'close');
  assert.equal(mentionKeyAction('Enter', { count: 3, composing: true }), undefined);
  assert.equal(mentionKeyAction('Tab', { count: 3, composing: true }), undefined);
  assert.equal(mentionKeyAction('ArrowDown', { count: 3, composing: true }), undefined);
  assert.equal(mentionKeyAction('Enter', { count: 0 }), undefined);
  assert.equal(mentionKeyAction('a', { count: 3 }), undefined);
});
