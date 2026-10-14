import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContextItem } from './chatContext';
import { MAX_TERMINAL_BYTES } from './chatContext';
import {
  composerEditable, composerSnapshot, decodeLocalRecovery, encodeLocalRecovery, liveMentionSignatures, localRecoveryDiffers,
  mentionDescription, mentionInsertedText, mentionPickStillValid, serializeComposerSnapshot, tentativeMentionPick,
  type MentionPickTicket,
} from './composerMentions';
import { addMentionEntry, inlineMentionToken, type MentionEntry } from './inlineMentions';

const file = (path: string): Extract<ContextItem, { kind: 'file' }> => ({ kind: 'file', id: `file:${path}`, path });
const entry = (path: string): MentionEntry => ({ token: inlineMentionToken(file(path), []), item: file(path) });

test('composerSnapshot resolves the active mentions and copies the inputs', () => {
  const catalogue = [entry('src/cart.ts'), entry('src/checkout.ts')];
  const tray: ContextItem[] = [{ kind: 'quote', id: 'q1', sourceTitle: 'Quote', text: 'hello' }];
  const snapshot = composerSnapshot('see @cart.ts and @checkout.ts', tray, catalogue, 'C:/repo');
  assert.deepEqual(snapshot.active.map(e => e.token), ['@cart.ts', '@checkout.ts']);
  assert.equal(snapshot.trayItems.length, 1);
  // The snapshot is a copy: later mutations of the tray do not leak in.
  tray.push({ kind: 'quote', id: 'q2', sourceTitle: 'Quote2', text: 'x' });
  assert.equal(snapshot.trayItems.length, 1);
  assert.match(serializeComposerSnapshot(snapshot, 'C:/repo'), /\[ThreadTerm message; mentions v1 \{"@cart.ts":2,"@checkout.ts":3\}\]\nsee @cart.ts and @checkout.ts$/);
});

test('composerSnapshot deduplicates an identity shared by a tray item and a mention', () => {
  const item = file('src/cart.ts');
  const mention: MentionEntry = { token: '@cart.ts', item };
  const tray: ContextItem[] = [{ kind: 'file', id: 'attach-1', path: 'src/cart.ts' }];
  const value = serializeComposerSnapshot(composerSnapshot('@cart.ts', tray, [mention], 'C:/repo'), 'C:/repo');
  assert.equal((value.match(/\[ThreadTerm context/g) ?? []).length, 1);
  assert.match(value, /\[ThreadTerm message; mentions v1 \{"@cart.ts":1\}\]/);
});

test('tentativeMentionPick rejects the 13th identity and the byte limit without touching the text', () => {
  const catalogue: MentionEntry[] = Array.from({ length: 12 }, (_, index) => entry(`src/file-${index}.ts`));
  const thirteenth = addMentionEntry(catalogue, file('src/extra.ts'), 'C:/repo');
  if ('error' in thirteenth) throw new Error('unexpected capacity');
  const text = `${catalogue.map(item => item.token).join(' ')} @extra.ts `;
  const rejected = tentativeMentionPick({ text, trayItems: [], catalogue: thirteenth.catalogue, workspaceRoot: 'C:/repo' });
  assert.equal(rejected.ok, false);
  if (rejected.ok) throw new Error('expected rejection');
  assert.match(String((rejected.error as Error).message), /12/);

  const huge: ContextItem[] = Array.from({ length: 5 }, (_, index) => ({ kind: 'quote', id: `huge-${index}`, sourceTitle: `Huge ${index}`, text: 'x'.repeat(MAX_TERMINAL_BYTES) }));
  const bytes = tentativeMentionPick({ text: 'see @cart.ts ', trayItems: huge, catalogue: [entry('src/cart.ts')], workspaceRoot: 'C:/repo' });
  assert.equal(bytes.ok, false);
  if (bytes.ok) throw new Error('expected byte rejection');
  assert.match(String((bytes.error as Error).message), /128 KiB/);
  assert.equal(mentionInsertedText('see @car', { start: 4, end: 8 }, '@cart.ts'), 'see @cart.ts ');
});

test('a pick ticket is dropped after every transition and kept when nothing changed', () => {
  const base = { lifecycle: {}, sessionId: 'a', composerGeneration: 2, text: 'x @car', composing: false, editable: true };
  const ticket: MentionPickTicket = { id: 1, lifecycle: base.lifecycle, sessionId: 'a', composerGeneration: 2, start: 2, end: 6, queryText: '@car' };
  assert.equal(mentionPickStillValid(ticket, base), true);
  assert.equal(mentionPickStillValid(ticket, { ...base, text: 'x @rar' }), false, 'token edited');
  assert.equal(mentionPickStillValid(ticket, { ...base, editable: false }), false, 'submission started / not writable / recovery pending');
  assert.equal(mentionPickStillValid(ticket, { ...base, composing: true }), false, 'composing');
  assert.equal(mentionPickStillValid(ticket, { ...base, composerGeneration: 3 }), false, 'restored/cleared');
  assert.equal(mentionPickStillValid(ticket, { ...base, sessionId: 'b' }), false, 'session switched');
  assert.equal(mentionPickStillValid(ticket, { ...base, lifecycle: {} }), false, 'A→B→A lifecycle');
});

test('composerEditable mirrors the textarea disabled conditions', () => {
  const open = { writable: true, ended: false, busy: false, draftLoaded: true, overlayFull: false, recoveryPending: false };
  assert.equal(composerEditable(open), true);
  for (const key of ['writable', 'ended', 'busy', 'draftLoaded', 'overlayFull', 'recoveryPending'] as const) {
    const blocked = key === 'writable' || key === 'draftLoaded' ? false : true;
    assert.equal(composerEditable({ ...open, [key]: blocked }), false, `${key} blocks edits`);
  }
});

test('the local recovery value is one versioned pair; legacy plain text still reads', () => {
  const catalogue = [entry('src/cart.ts')];
  const encoded = encodeLocalRecovery('see @cart.ts', catalogue, 'C:/repo');
  const parsed = JSON.parse(encoded);
  assert.equal(parsed.v, 2);
  assert.equal(parsed.text, 'see @cart.ts');
  assert.equal(parsed.mentions.length, 1);
  const decoded = decodeLocalRecovery(encoded);
  assert.equal(decoded.text, 'see @cart.ts');
  assert.equal(decoded.mentions[0]?.token, '@cart.ts');
  assert.deepEqual(decodeLocalRecovery('plain draft'), { text: 'plain draft', mentions: [] });

  const runtime = { text: 'see @cart.ts', mentions: catalogue };
  assert.equal(localRecoveryDiffers(decoded, runtime, 'C:/repo'), false);
  assert.equal(localRecoveryDiffers({ text: 'see @cart.ts', mentions: [entry('src/other.ts')] }, runtime, 'C:/repo'), true, 'same text, different mapping');
  assert.equal(localRecoveryDiffers({ text: 'changed', mentions: catalogue }, runtime, 'C:/repo'), true, 'text differs');
  assert.equal(liveMentionSignatures('see @cart.ts', catalogue, 'C:/repo'), '@cart.ts\u0000file:src/cart.ts');
});

test('the screen-reader line lists every active mention in en and zh-CN', () => {
  const active: MentionEntry[] = [entry('src/cart.ts'), { token: '@codex', item: { kind: 'agent', id: 'agent:codex', provider: 'codex' } }];
  assert.equal(mentionDescription(active, false), 'Mentions: cart.ts (file), codex (agent)');
  assert.equal(mentionDescription(active, true), '提及：cart.ts（文件）、codex（代理）');
  assert.equal(mentionDescription([], false), '');
});
