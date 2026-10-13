import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { createRequire } from 'node:module';
Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import('react-dom/server');
import { SteerSend } from './SteerSend';
import { ChatQueue } from './ChatQueue';
import type { ChatQueue as ChatQueueState } from '@threadterm/protocol';

const renderSend = (kind: 'send' | 'queue' | 'split', disabled = false) => renderToStaticMarkup(createElement(SteerSend, {
  kind, disabled, busy: false, copy: (en: string) => en, onInsert: () => {},
}));

test('the split control keeps Queue as the main action and parks Insert in a closed menu', () => {
  const split = renderSend('split');
  assert.match(split, /data-testid="steer-send"/);
  assert.equal((split.match(/chat-compose-send/g) ?? []).length, 2);
  assert.match(split, /aria-haspopup="menu"/);
  assert.match(split, /aria-expanded="false"/);
  assert.match(split, /aria-label="Queue"/);
  assert.match(split, /aria-label="More send actions"/);
  assert.equal(split.includes('data-testid="steer-menu"'), false);
  assert.match(split, /icon-btn icon-btn-sm icon-btn-round is-primary chat-compose-send is-queue/);
  const send = renderSend('send');
  assert.equal(send.includes('steer-send'), false);
  assert.match(send, /aria-label="Send"/);
  assert.equal((send.match(/<button/g) ?? []).length, 1);
  const queued = renderSend('queue');
  assert.match(queued, /aria-label="Queue"/);
  assert.equal((queued.match(/<button/g) ?? []).length, 1);
  assert.match(renderSend('split', true), /disabled=""/);
});

const queue = (state: ChatQueueState['items'][number]['state'] = 'queued'): ChatQueueState => ({
  sessionId: 's', paused: false, items: [{ id: 'q1', text: 'follow up', images: [], revision: 1, createdAt: 'now', updatedAt: 'now', state }],
});

test('Insert now and Send now are mutually exclusive', () => {
  const inserted = renderToStaticMarkup(createElement(ChatQueue, {
    sessionId: 's', queue: queue(), leaseEpoch: 1, writable: true, idle: false, canInsert: true,
    onInsertNow: async () => {}, ingressFailed: false, onChange: () => {}, onIssue: () => {}, zh: false,
  }));
  assert.match(inserted, /data-testid="queue-insert-now"/);
  assert.match(inserted, />Insert now</);
  assert.equal(inserted.includes('Send now'), false);
  const zh = renderToStaticMarkup(createElement(ChatQueue, {
    sessionId: 's', queue: queue(), leaseEpoch: 1, writable: true, idle: false, canInsert: true,
    onInsertNow: async () => {}, ingressFailed: false, onChange: () => {}, onIssue: () => {}, zh: true,
  }));
  assert.match(zh, />立即插入</);
  const idle = renderToStaticMarkup(createElement(ChatQueue, {
    sessionId: 's', queue: queue(), leaseEpoch: 1, writable: true, idle: true, canInsert: false,
    ingressFailed: false, onChange: () => {}, onIssue: () => {}, zh: false,
  }));
  assert.match(idle, />Send now</);
  assert.equal(idle.includes('Insert now'), false);
  assert.equal(idle.includes('queue-insert-now'), false);
});
