import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatQueue } from '@threadterm/protocol';
import { queueActionAvailability, queueComposerMode, queueItemSummary, queuePauseReason, queueRequestIssue } from './chatQueue';

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

test('queue actions use the runtime blocker', () => {
  const blocked = (reason: 'plan' | 'approval' | 'working' | 'unavailable') => ({ ...queue, blocked: reason });
  assert.deepEqual(queueActionAvailability(blocked('plan')), { available: false, reason: 'Waiting for your plan review' });
  assert.deepEqual(queueActionAvailability(blocked('plan'), true), { available: false, reason: '等待你审阅计划' });
  assert.deepEqual(queueActionAvailability({ ...queue, blocked: undefined }), { available: true });
  assert.deepEqual(queueActionAvailability({ ...queue, pauseReason: 'failed', blocked: undefined }), { available: true });
  assert.deepEqual(queueActionAvailability(undefined), { available: false });
  assert.equal(queueRequestIssue('RuntimeRequestError: chat_busy'), 'The agent is still working. Try again in a moment.');
  assert.equal(queueRequestIssue('RuntimeRequestError: stale_lease'), 'RuntimeRequestError: stale_lease');
  assert.equal(queueRequestIssue('RuntimeRequestError: chat_queue_unavailable', true), 'RuntimeRequestError: chat_queue_unavailable');
});
