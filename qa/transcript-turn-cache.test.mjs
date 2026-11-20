import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptTurnCache } from '../renderer/src/transcriptTurnCache.ts';

test('historical turns retain the exact rendered value while a live sibling changes', () => {
  const cache = createTranscriptTurnCache();
  const context = {};
  const historicalItem = { id: 'settled' };
  const historical = { id: 'turn-settled', items: [historicalItem], cacheable: true };
  let renders = 0;
  const first = cache.render(historical, context, ['completed'], () => ({ render: ++renders }));

  // A live sibling can receive a replacement item without changing history.
  cache.render({ id: 'turn-live', items: [{ id: 'live', text: 'next' }], cacheable: false }, context, ['live'], () => ({ render: ++renders }));
  const second = cache.render({ ...historical, items: [historicalItem] }, context, ['completed'], () => ({ render: ++renders }));

  assert.equal(second, first);
  assert.equal(renders, 2);
});

test('historical turn cache invalidates item, outcome and rendering context changes', () => {
  const cache = createTranscriptTurnCache();
  const item = { id: 'answer' };
  let renders = 0;
  const render = () => ({ render: ++renders });
  const englishWritable = {};
  const group = { id: 'turn', items: [item], cacheable: true };

  const initial = cache.render(group, englishWritable, ['completed', 'answer'], render);
  assert.notEqual(cache.render({ ...group, items: [{ ...item }] }, englishWritable, ['completed', 'answer'], render), initial);
  assert.notEqual(cache.render(group, englishWritable, ['interrupted', 'answer'], render), initial);
  assert.notEqual(cache.render(group, {}, ['completed', 'answer'], render), initial);
  assert.equal(renders, 4);
});

test('live turns are never cached and pruned turns cannot reappear stale', () => {
  const cache = createTranscriptTurnCache();
  const context = {};
  const live = { id: 'live', items: [{}], cacheable: false };
  let renders = 0;
  const render = () => ({ render: ++renders });
  assert.notEqual(cache.render(live, context, [], render), cache.render(live, context, [], render));

  const historical = { ...live, id: 'historical', cacheable: true };
  const first = cache.render(historical, context, [], render);
  cache.prune(new Set());
  assert.notEqual(cache.render(historical, context, [], render), first);
  assert.equal(renders, 4);
});
