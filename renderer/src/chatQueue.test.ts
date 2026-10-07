import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatQueue } from '@threadterm/protocol';
import { queueComposerMode, queueItemSummary, queuePauseReason } from './chatQueue';

const queue: ChatQueue = { sessionId: 's', paused: true, pauseReason: 'stopped', items: [{ id: 'i', text: 'first line\nsecond line', images: ['data:image/png;base64,AAAA'], revision: 1, createdAt: 'now', updatedAt: 'now', state: 'queued' }] };

test('composer queues while a turn runs or a paused queue has items', () => {
  assert.equal(queueComposerMode(true, undefined), true);
  assert.equal(queueComposerMode(false, queue), true);
  assert.equal(queueComposerMode(false, { ...queue, paused: false }), false);
});

test('queue summaries retain the first line and attachment count', () => {
  assert.equal(queueItemSummary(queue.items[0]!), 'first line · 1 image');
  assert.equal(queueItemSummary({ text: '', images: ['a', 'b'] }, true), '仅图片 · 2 张图片');
  assert.equal(queuePauseReason('stopped'), 'Paused after stopping');
  assert.equal(queuePauseReason('disconnected', true), '连接断开后已暂停');
});
