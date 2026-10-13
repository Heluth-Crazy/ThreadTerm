import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem } from '@threadterm/protocol';
import { beginResync, chatUiFromEvent, completeResync, nextRepairRevision, restoreChat, upsertChatItem } from './chatState';
import { createCodexStreamQueue } from './codexStream';

const item = (id: string, text = id): ChatItem => ({ id, role: 'assistant', parts: [{ type: 'text', text }], createdAt: 'now' });

test('chat.ui preserves images and optional load/error fields as a complete snapshot', () => {
  const error = { code: 'options_failed', message: 'Try again' };
  assert.deepEqual(chatUiFromEvent({ options: [], commands: [], inputCapabilities: { images: true }, loadState: 'error', error }), {
    options: [], commands: [], inputCapabilities: { images: true }, loadState: 'error', error,
  });
  assert.deepEqual(chatUiFromEvent({}), { options: [], commands: [], inputCapabilities: {}, loadState: 'empty' });
  assert.equal(chatUiFromEvent({ options: [{ id: 'model', name: 'Model', value: 'new', choices: [] }] }).loadState, 'ready');
});

test('background tasks survive full UI snapshots, and old/empty snapshots remove stale tasks', () => {
  const backgroundTasks = [{ id: 'bg', title: 'Build', status: 'running' as const, canStop: false }];
  assert.deepEqual(chatUiFromEvent({ backgroundTasks }).backgroundTasks, backgroundTasks);
  assert.deepEqual(chatUiFromEvent({ backgroundTasks: [] }).backgroundTasks, []);
  assert.equal(chatUiFromEvent({}).backgroundTasks, undefined);
});

test('resync restores snapshot and only newer buffered events without duplicates', () => {
  const resync = beginResync('s', 2);
  resync.buffered.push({ seq: 9, item: item('a', 'stale') }, { seq: 11, item: item('a', 'new') }, { seq: 12, item: item('b') }, { seq: 12, item: item('b') });
  assert.deepEqual(completeResync(resync, 's', 2, [item('old')], { revision: 10, items: [item('a', 'snapshot')] }), [item('a', 'new'), item('b')]);
});

test('resync rejects stale generations and other sessions', () => {
  const first = beginResync('s', 2);
  first.buffered.push({ seq: 11, item: item('a') });
  const current = beginResync('s', 4, first);
  assert.equal(completeResync(current, 's', 2, [], { revision: 10, items: [item('stale')] }), undefined);
  assert.equal(completeResync(current, 'other', 4, []), undefined);
  assert.deepEqual(completeResync(current, 's', 4, [], { revision: 10, items: [] }), [item('a')]);
  assert.deepEqual(beginResync('other', 5, current).buffered, []);
});

test('snapshot expiry replaces old pending approval and older buffered pending updates', () => {
  const pending: ChatItem = { ...item('approval'), parts: [{ type: 'approval', status: 'pending', data: { approvalId: 'request' } }] };
  const expired: ChatItem = { ...pending, parts: [{ ...pending.parts[0], status: 'expired' }] };
  const resync = beginResync('s', 2);
  resync.buffered.push({ seq: 9, item: pending });
  assert.deepEqual(completeResync(resync, 's', 2, [pending], { revision: 10, items: [expired] }), [expired]);
});

test('snapshot failure keeps current items and applies buffered events in sequence order', () => {
  const resync = beginResync('s', 2);
  resync.buffered.push({ seq: 12, item: item('a', 'latest') }, { seq: 11, item: item('a', 'earlier') }, { seq: 13, item: item('b') });
  assert.deepEqual(completeResync(resync, 's', 2, [item('a'), item('kept')]), [item('a', 'latest'), item('kept'), item('b')]);
});

test('chat.ui keeps native steer and does not invent a note capability', () => {
  assert.deepEqual(chatUiFromEvent({ inputCapabilities: { images: true, steer: 'native' } }).inputCapabilities, { images: true, steer: 'native' });
  assert.deepEqual(chatUiFromEvent({ commands: [] }).inputCapabilities, {});
});

test('an empty user item removes a rejected steer and an empty assistant item stays', () => {
  const user = item('s:user:turn-a', 'start');
  const steered = { ...item('s:user:steer:op-1', 'while you work'), role: 'user' as const, parts: [{ type: 'text' as const, text: 'while you work', data: { steered: true, turnId: 'turn-a' } }] };
  const assistant = { ...item('s:assistant:turn-a', ''), parts: [] as ChatItem['parts'] };
  const kept = upsertChatItem(upsertChatItem([user], steered), assistant);
  assert.deepEqual(kept.map(entry => entry.id), ['s:user:turn-a', 's:user:steer:op-1', 's:assistant:turn-a']);
  const removed = upsertChatItem(kept, { ...steered, parts: [] });
  assert.deepEqual(removed.map(entry => entry.id), ['s:user:turn-a', 's:assistant:turn-a']);
  assert.deepEqual(restoreChat({ items: kept, revision: 1 }, [{ seq: 2, item: { ...steered, parts: [] } }]).map(entry => entry.id), ['s:user:turn-a', 's:assistant:turn-a']);
});

test('repair state changes only start one newer revision fence', () => {
  assert.equal(nextRepairRevision(7, 8), 8);
  assert.equal(nextRepairRevision(8, 8), undefined);
  assert.equal(nextRepairRevision(8, 7), undefined);
  assert.equal(nextRepairRevision(8, '9'), undefined);
});

test('disposing the pre-resync Codex stream cancels queued snapshots and resets deduplication', () => {
  const delivered: ChatItem[] = [];
  const stream = createCodexStreamQueue(next => delivered.push(next), 60_000);
  const streaming = { ...item('a', 'before'), parts: [{ type: 'text' as const, text: 'before', status: 'streaming' }] };
  stream.push(streaming);
  stream.push(item('a', 'queued'));
  stream.dispose();
  stream.push(item('a', 'after disposal'));
  const fresh = createCodexStreamQueue(next => delivered.push(next));
  fresh.push(item('a', 'snapshot'));
  fresh.dispose();
  assert.deepEqual(delivered, [streaming, item('a', 'snapshot')]);
});
