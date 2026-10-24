import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { GroupMember, GroupMessage, Session } from '@threadterm/protocol';
import { byteLabel, byteSize, describeGroupReference, droppedGroupReferences, groupComposition, groupEnterSends, groupMemberStatus, groupSuggestions, insertGroupMention, leadingGroupRecipientKey, mentionCompletion, mergeGroupMessages, replyReferenceHandle, selectedGroupRecipients } from './groupComposer';
const member = (handle: string): GroupMember => ({ handle, sessionId: handle, provider: handle, mode: 'default', state: 'idle', joinedAt: '' });
const user: GroupMessage = { id: 'user', author: 'user', body: 'Write your own page', createdAt: '2026-01-01T00:00:00Z' };
const reply: GroupMessage = { id: 'reply', author: 'member', handle: 'codex', sessionId: 'codex', body: 'Independent page', replyTo: 'user', createdAt: '2026-01-01T00:00:01Z', outputs: { files: ['codex/index.html'], urls: [], changed: ['codex/index.html'] } };
const group = { members: [member('claude'), member('codex')], lastRecipients: [], messages: [user, reply] };
test('leading mentions route and inline mentions attach only the chosen latest reply', () => {
 const text = "@claude critique @codex's page", value = groupComposition(text, group);
 assert.deepEqual(value.to, ['claude']); assert.equal(value.references[0].messageId, 'reply'); assert.deepEqual(value.unresolved, []); assert.equal(text, "@claude critique @codex's page");
 assert.deepEqual(groupComposition('@All write independently', group).to, ['all']);
 assert.deepEqual(groupComposition('Continue', { ...group, lastRecipients: ['codex'] }).to, ['codex']);
 assert.deepEqual(groupComposition('First message', group).to, ['all']);
 assert.deepEqual(groupComposition('@missing help', group).unknownHandles, ['missing']);
 const renamed = { ...group, members: group.members.map(member => member.handle === 'codex' ? { ...member, handle: 'writer' } : member) };
 assert.equal(groupComposition('@claude review @writer', renamed).references[0]?.messageId, 'reply');
});
test('mention autocomplete and Enter are safe during IME composition', () => {
 assert.equal(mentionCompletion('@cl', 3, true), undefined);
 assert.deepEqual(insertGroupMention('@cl review', mentionCompletion('@cl review', 3)!, 'claude'), { text: '@claude  review', caret: 8 });
 assert.equal(mentionCompletion('mail@example', 12), undefined);
 assert.equal(groupEnterSends({ key: 'Enter', isComposing: true }, false), false);
 assert.equal(groupEnterSends({ key: 'Enter', keyCode: 229 }, false), false);
 assert.equal(groupEnterSends({ key: 'Enter' }, true), false);
 assert.equal(groupEnterSends({ key: 'Enter', shiftKey: true }, false), false);
 assert.equal(groupEnterSends({ key: 'Enter' }, false), true);
});
test('reference chips count UTF-8 bytes and preserve output identifiers when shortened', () => {
 const ref = describeGroupReference({ kind: 'reply', messageId: 'reply' }, group.messages);
 assert.equal(ref.bytes, byteSize(`\n\n## Referenced: @codex's reply (to: "Write your own page")\nIndependent page\nOutputs: ${JSON.stringify(reply.outputs)}`));
 assert.equal(byteSize('中文'), 6); assert.equal(byteLabel(1024), '1.0 KB');
 const large = describeGroupReference({ kind: 'reply', messageId: 'reply' }, [user, { ...reply, body: '中'.repeat(10000) }]);
 assert.equal(large.shortened, true); assert.ok(large.bytes <= 8192); assert.equal(large.missing, false);
 assert.equal(describeGroupReference({ kind: 'reply', messageId: 'absent' }, []).missing, true);
 assert.equal(describeGroupReference({ kind: 'reply', messageId: 'reply' }, [reply]).missing, true);
 assert.deepEqual(groupComposition('@claude review @codex', { ...group, messages: [reply] }).unresolved, ['codex']);
});
test('reply chips keep the full title for a tooltip while exposing only the compact handle label', () => {
 const reference = { kind: 'reply' as const, title: '@codex\'s reply (to: "@claude critique @codex\'s page. Read the explicitly referenced page")', bytes: 1638 };
 assert.equal(replyReferenceHandle(reference), 'codex');
 assert.equal(replyReferenceHandle({ ...reference, handle: 'writer' }), 'writer');
 assert.equal(replyReferenceHandle({ kind: 'message' as const, title: 'Earlier message' }), undefined);
});
test('historical repeated suggestions collapse to one quiet action per handle', () => {
 assert.deepEqual(groupSuggestions([{ handle: 'codex', text: 'Review tests' }, { handle: 'codex', text: 'Run tests' }, { handle: 'claude', text: 'Check docs' }, { handle: 'codex', text: 'Review tests' }]), [
  { handle: 'codex', text: 'Review tests\nRun tests' }, { handle: 'claude', text: 'Check docs' },
 ]);
});
test('manual recipients persist for body edits and invalidate only when the leading recipient identity changes', () => {
 const handles = ['group-qa-a', 'group-qa-b'];
 assert.equal(leadingGroupRecipientKey('@group-qa-a revise', ['group-qa-a'], handles), 'group-qa-a');
 assert.deepEqual(selectedGroupRecipients('', ['group-qa-b'], handles, { key: '', to: ['group-qa-a'] }), ['group-qa-a']);
 assert.deepEqual(selectedGroupRecipients('Revise the page', ['group-qa-b'], handles, { key: '', to: ['group-qa-a'] }), ['group-qa-a']);
 assert.deepEqual(selectedGroupRecipients('@group-qa-a revise', ['group-qa-a'], handles, { key: 'group-qa-a', to: [] }), []);
 assert.deepEqual(selectedGroupRecipients('@group-qa-a revise this', ['group-qa-a'], handles, { key: 'group-qa-a', to: ['group-qa-b'] }), ['group-qa-b']);
 assert.deepEqual(selectedGroupRecipients('@group-qa-b revise', ['group-qa-b'], handles, { key: 'group-qa-a', to: [] }), ['group-qa-b']);
});
test('status aggregation prefers user attention, then working, queued and replied', () => {
 const deliveries = [{ sessionId: 'codex', handle: 'codex', state: 'working' as const }];
 assert.equal(groupMemberStatus(member('codex'), undefined, [{ ...user, deliveries }]), 'working');
 assert.equal(groupMemberStatus({ ...member('codex'), state: 'needs_user' }, undefined, [{ ...user, deliveries }]), 'needs_user');
 assert.equal(groupMemberStatus(member('codex'), undefined, [{ ...user, deliveries: [{ ...deliveries[0], state: 'replied' }] }]), 'replied');
 assert.equal(groupMemberStatus(member('codex'), undefined, [{ ...user, deliveries: [{ ...deliveries[0], state: 'stopped' }] }]), 'stopped');
 assert.equal(groupMemberStatus(member('codex'), undefined, [{ ...user, deliveries: [{ ...deliveries[0], state: 'failed' }] }]), 'failed');
 const completed = { id: 'codex', status: 'idle', activity: { state: 'awaiting_input', revision: 1 } } as Session;
 assert.equal(groupMemberStatus({ ...member('codex'), state: 'needs_user' }, completed, [{ ...user, deliveries: [{ ...deliveries[0], state: 'replied' }] }]), 'replied');
 assert.equal(groupMemberStatus(member('codex'), { ...completed, status: 'waiting' }, []), 'needs_user');
 assert.equal(groupMemberStatus(member('codex'), completed, [{ ...user, deliveries: [{ ...deliveries[0], state: 'needs_user' }] }]), 'needs_user');
});
test('paged message merge updates deliveries without duplicating or reordering entries', () => {
 assert.deepEqual(mergeGroupMessages([reply], [user, { ...reply, body: 'updated' }]).map(message => message.id), ['user', 'reply']);
 assert.equal(mergeGroupMessages([reply], [{ ...reply, body: 'updated' }])[0].body, 'updated');
});
test('file and URL drops create explicit identifiers and reject out-of-folder paths', () => {
 assert.deepEqual(droppedGroupReferences('page/index.html\nhttps://example.invalid/page\n../secret\n/elsewhere/secret', '/workspace'), [{ kind: 'file', path: 'page/index.html' }, { kind: 'url', url: 'https://example.invalid/page' }]);
 assert.deepEqual(droppedGroupReferences('file:///workspace/page.html', '/workspace'), [{ kind: 'file', path: 'page.html' }]);
 assert.deepEqual(droppedGroupReferences('javascript:alert(1)\ndata:text/plain,secret', '/workspace'), []);
 const root = tmpdir(), canonical = process.platform === 'win32' ? `\\\\?\\${root}` : root;
 assert.deepEqual(droppedGroupReferences(join(root, 'page.html'), canonical), [{ kind: 'file', path: 'page.html' }]);
});
