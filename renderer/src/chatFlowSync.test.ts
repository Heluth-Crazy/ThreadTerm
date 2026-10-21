import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatViewWatched, onChatViewWatch, openAndRevealInChat, publishChatView, registerChatHandle, revealInChat, watchChatView, type ChatHandle } from './chatFlowSync';
import type { ChatViewState, TaskFlowChatTarget } from './taskMapTypes';

const state = (sessionId: string, item = 'item'): ChatViewState => ({ sessionId, items: [item], tools: ['tool'], turns: ['turn'], following: true });

test('watch immediately delivers undefined, publishes shown state, and compares every field by value', () => {
  const sessionId = 'sync-equality';
  const received: (ChatViewState | undefined)[] = [];
  const unwatch = watchChatView(sessionId, next => received.push(next));
  const handle: ChatHandle = { shown: () => true, reveal: () => false };
  const unregister = registerChatHandle(sessionId, handle);
  try {
    assert.deepEqual([...received], [undefined]);
    const original = state(sessionId);
    publishChatView(handle, original);
    publishChatView(handle, state(sessionId));
    assert.deepEqual(received, [undefined, original]);
    original.items.push('mutated');
    assert.deepEqual(received[1]?.items, ['item'], 'published arrays are retained by value');
    publishChatView(handle, { ...state(sessionId), tools: ['tool-2'] });
    publishChatView(handle, { ...state(sessionId), turns: ['turn-2'] });
    publishChatView(handle, { ...state(sessionId), following: false });
    publishChatView(handle, state(sessionId, 'item-2'));
    assert.equal(received.length, 6);
    publishChatView(handle, undefined);
    publishChatView(handle, undefined);
    assert.equal(received.length, 7);
    assert.equal(received.at(-1), undefined);
  } finally { unregister(); unwatch(); }
});

test('hidden handles never deliver; the latest shown publication wins and unregister restores the other handle', () => {
  const sessionId = 'sync-multiple';
  let firstShown = true, secondShown = false;
  const first: ChatHandle = { shown: () => firstShown, reveal: () => false };
  const second: ChatHandle = { shown: () => secondShown, reveal: () => false };
  const unregisterFirst = registerChatHandle(sessionId, first);
  const unregisterSecond = registerChatHandle(sessionId, second);
  const received: (ChatViewState | undefined)[] = [];
  const unwatch = watchChatView(sessionId, next => received.push(next));
  try {
    publishChatView(first, state(sessionId, 'first'));
    publishChatView(second, state(sessionId, 'second'));
    assert.equal(received.length, 2);
    secondShown = true;
    publishChatView(second, state(sessionId, 'second'));
    assert.deepEqual(received.at(-1)?.items, ['second']);
    publishChatView(first, state(sessionId, 'first'));
    assert.deepEqual(received.at(-1)?.items, ['first'], 'equal re-publication still becomes the newest source');
    firstShown = false;
    publishChatView(first, state(sessionId, 'hidden'));
    assert.deepEqual(received.at(-1)?.items, ['second']);
    unregisterSecond();
    assert.equal(received.at(-1), undefined);
    firstShown = true;
    publishChatView(first, state(sessionId, 'restored'));
    const replay: (ChatViewState | undefined)[] = [];
    const stopReplay = watchChatView(sessionId, next => replay.push(next));
    assert.deepEqual(replay, [state(sessionId, 'restored')]);
    stopReplay();
    unregisterFirst();
    assert.equal(received.at(-1), undefined);
    const count = received.length;
    publishChatView(first, state(sessionId));
    assert.equal(received.length, count, 'unregistered handles cannot republish');
  } finally { unregisterFirst(); unregisterSecond(); unwatch(); }
});

test('unregistering the newest shown handle falls back to the older shown handle', () => {
  const sessionId = 'sync-fallback';
  const first: ChatHandle = { shown: () => true, reveal: () => false };
  const second: ChatHandle = { shown: () => true, reveal: () => false };
  const stopFirst = registerChatHandle(sessionId, first), stopSecond = registerChatHandle(sessionId, second);
  const received: (ChatViewState | undefined)[] = [];
  const unwatch = watchChatView(sessionId, next => received.push(next));
  try {
    publishChatView(first, state(sessionId, 'older'));
    publishChatView(second, state(sessionId, 'newer'));
    stopSecond();
    assert.deepEqual(received.at(-1), state(sessionId, 'older'));
    stopFirst();
    assert.equal(received.at(-1), undefined);
  } finally { stopFirst(); stopSecond(); unwatch(); }
});

test('watch transitions occur only on the first watch and last unwatch, independently per session', () => {
  const sessionId = 'sync-watch-count';
  const transitions: boolean[] = [];
  const stopTransitions = onChatViewWatch(sessionId, watched => transitions.push(watched));
  assert.equal(chatViewWatched(sessionId), false);
  assert.deepEqual(transitions, [false]);
  const stopFirst = watchChatView(sessionId, () => {});
  const stopSecond = watchChatView(sessionId, () => {});
  const stopOther = watchChatView('sync-other', () => {});
  assert.equal(chatViewWatched(sessionId), true);
  assert.deepEqual(transitions, [false, true]);
  stopFirst(); stopFirst();
  assert.equal(chatViewWatched(sessionId), true);
  stopSecond();
  assert.equal(chatViewWatched(sessionId), false);
  assert.deepEqual(transitions, [false, true, false]);
  stopTransitions(); stopOther();
});

test('reveal uses registration order, skips hidden and unsuccessful handles, and stays in the target session', () => {
  const calls: string[] = [];
  const target = { sessionId: 'sync-reveal', toolId: 'tool-id', itemId: 'item-id', turnItemId: 'turn-id' };
  const add = (name: string, visible: boolean, result: boolean, sessionId = target.sessionId) => registerChatHandle(sessionId, {
    shown: () => visible, reveal: next => { assert.deepEqual(next, target); calls.push(name); return result; },
  });
  const stops = [add('hidden', false, true), add('miss', true, false), add('hit', true, true), add('later', true, true), add('other', true, true, 'sync-not-target')];
  try {
    assert.equal(revealInChat(target), true);
    assert.deepEqual(calls, ['miss', 'hit']);
    stops[2]!(); stops[3]!();
    calls.length = 0;
    assert.equal(revealInChat(target), false);
    assert.deepEqual(calls, ['miss']);
    assert.equal(revealInChat({ sessionId: 'sync-missing' }), false);
  } finally { for (const stop of stops) stop(); }
});

function frameQueue(run: (frames: { size(): number; tick(): void; drain(): number }) => void): void {
  const request = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const cancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  let id = 0;
  const queue = new Map<number, FrameRequestCallback>();
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { queue.set(++id, callback); return id; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (frame: number) => queue.delete(frame) });
  const tick = () => {
    const callbacks = [...queue.values()]; queue.clear();
    for (const callback of callbacks) callback(0);
  };
  try {
    run({ size: () => queue.size, tick, drain: () => {
      let ticks = 0;
      while (queue.size && ticks < 100) { tick(); ticks += 1; }
      assert.equal(queue.size, 0, 'retry frames must be bounded');
      return ticks;
    } });
    assert.equal(queue.size, 0, 'no frame survives the request');
  } finally {
    if (request) Object.defineProperty(globalThis, 'requestAnimationFrame', request); else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (cancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', cancel); else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }
}

test('openAndReveal opens once and reveals once a shown Chat registers', () => frameQueue(frames => {
  const target: TaskFlowChatTarget = { sessionId: 'sync-open', itemId: 'item' };
  const opened: string[] = [], revealed: TaskFlowChatTarget[] = [];
  openAndRevealInChat(target, sessionId => opened.push(sessionId));
  assert.deepEqual(opened, [target.sessionId]);
  frames.tick();
  assert.deepEqual(opened, [target.sessionId]);
  const stop = registerChatHandle(target.sessionId, { shown: () => true, reveal: next => { revealed.push(next); return true; } });
  try { frames.tick(); assert.deepEqual(revealed, [target]); assert.equal(frames.size(), 0); }
  finally { stop(); }
}));

test('openAndReveal reveals immediately without opening or scheduling when the Chat is shown', () => frameQueue(frames => {
  const target = { sessionId: 'sync-immediate' };
  let reveals = 0, opens = 0;
  const stop = registerChatHandle(target.sessionId, { shown: () => true, reveal: () => { reveals += 1; return true; } });
  try {
    openAndRevealInChat(target, () => { opens += 1; });
    assert.equal(reveals, 1); assert.equal(opens, 0); assert.equal(frames.size(), 0);
  } finally { stop(); }
}));

test('a newer openAndReveal cancels the pending older target', () => frameQueue(frames => {
  const older = { sessionId: 'sync-cancel-old' }, newer = { sessionId: 'sync-cancel-new' };
  const revealed: string[] = [];
  openAndRevealInChat(older);
  openAndRevealInChat(newer);
  assert.equal(frames.size(), 1);
  const stops = [older, newer].map(target => registerChatHandle(target.sessionId, {
    shown: () => true, reveal: () => { revealed.push(target.sessionId); return true; },
  }));
  try { frames.tick(); assert.deepEqual(revealed, [newer.sessionId]); }
  finally { for (const stop of stops) stop(); }
}));

test('even an immediately revealed newer call cancels a pending older call', () => frameQueue(frames => {
  openAndRevealInChat({ sessionId: 'sync-cancel-pending' });
  const stop = registerChatHandle('sync-cancel-immediate', { shown: () => true, reveal: () => true });
  try { openAndRevealInChat({ sessionId: 'sync-cancel-immediate' }); assert.equal(frames.size(), 0); }
  finally { stop(); }
}));

test('openAndReveal exhausts its frame budget and leaves no callback behind', () => frameQueue(frames => {
  let opens = 0;
  openAndRevealInChat({ sessionId: 'sync-timeout' }, () => { opens += 1; });
  assert.equal(frames.drain(), 60);
  assert.equal(opens, 1);
}));

test('reveal prefers the Chat that published last; a shown Chat that misses fails without opening', () => frameQueue(frames => {
  const target = { sessionId: 'sync-prefer', itemId: 'item' };
  const calls: string[] = [];
  const older: ChatHandle = { shown: () => true, reveal: () => { calls.push('older'); return true; } };
  const newer: ChatHandle = { shown: () => true, reveal: () => { calls.push('newer'); return true; } };
  const stops = [registerChatHandle(target.sessionId, older), registerChatHandle(target.sessionId, newer)];
  try {
    publishChatView(newer, { sessionId: target.sessionId, items: ['item'], tools: [], turns: [], following: false });
    assert.equal(revealInChat(target), true);
    assert.deepEqual(calls, ['newer']);
  } finally { for (const stop of stops) stop(); }
  const missTarget = { sessionId: 'sync-miss', itemId: 'gone' };
  let opens = 0, failures = 0;
  const stop = registerChatHandle(missTarget.sessionId, { shown: () => true, reveal: () => false });
  try {
    openAndRevealInChat(missTarget, () => { opens += 1; }, () => { failures += 1; });
    assert.equal(opens, 0); assert.equal(failures, 1); assert.equal(frames.size(), 0);
  } finally { stop(); }
}));

test('openAndReveal reports a timeout once', () => frameQueue(frames => {
  let failures = 0;
  openAndRevealInChat({ sessionId: 'sync-timeout-report' }, undefined, () => { failures += 1; });
  frames.drain();
  assert.equal(failures, 1);
}));
