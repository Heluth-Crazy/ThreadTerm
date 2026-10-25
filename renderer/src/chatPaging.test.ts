import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatItem } from '@threadterm/protocol';
import { anchoredScrollTop, loadAllChatPages, MAX_CHAT_PAGES, mergeEarlierPage, needsAnotherPage, shouldLoadEarlier, type ChatPage } from './chatPaging';

function item(id: string, text = id): ChatItem {
  return { id, role: 'user', createdAt: `2026-01-01T00:00:${id.padStart(2, '0')}Z`, parts: [{ type: 'text', text }] };
}

test('an earlier page is prepended once and never duplicates live items', () => {
  const current = [item('05', 'updated by a live event'), item('06')];
  assert.deepEqual(mergeEarlierPage(current, [item('03'), item('04'), item('05', 'stale page copy')]).map(entry => entry.id), ['03', '04', '05', '06']);
  assert.equal(mergeEarlierPage(current, [item('03')])[1].parts[0].text, 'updated by a live event');
  assert.equal(mergeEarlierPage(current, []), current, 'an empty page keeps the same array');
  // Loading the same cursor twice changes nothing.
  const once = mergeEarlierPage(current, [item('03')]);
  assert.equal(mergeEarlierPage(once, [item('03')]), once);
});

test('a whole-transcript read walks every page and restores transcript order', async () => {
  const pages: ChatPage[] = [
    { items: [item('07'), item('08')], revision: 3, hasEarlier: true, nextBefore: 'b' },
    { items: [item('05'), item('06')], revision: 3, hasEarlier: true, nextBefore: 'a' },
    { items: [item('01'), item('02')], revision: 3, hasEarlier: false },
  ];
  const asked: (string | undefined)[] = [];
  const items = await loadAllChatPages(before => { asked.push(before); return Promise.resolve(pages[asked.length - 1]); });
  assert.deepEqual(asked, [undefined, 'b', 'a']);
  assert.deepEqual(items.map(entry => entry.id), ['01', '02', '05', '06', '07', '08']);
});

test('a repeating cursor stops the walk instead of looping forever', async () => {
  let calls = 0;
  const items = await loadAllChatPages(() => { calls += 1; return Promise.resolve({ items: [item(String(calls))], revision: 1, hasEarlier: true, nextBefore: 'same' }); });
  assert.equal(calls, 2);
  assert.equal(items.length, 2);
  assert.ok(calls < MAX_CHAT_PAGES);
});

test('the scroll anchor keeps the read message in place when a page is prepended', () => {
  assert.equal(anchoredScrollTop(0, 1200, 3000), 1800);
  assert.equal(anchoredScrollTop(240, 1200, 3000), 2040);
  assert.equal(anchoredScrollTop(0, 1200, 1000), 0, 'a shrinking transcript never yields a negative offset');
});

test('only a near-top viewport without a request in flight pages back', () => {
  assert.equal(shouldLoadEarlier(0, true, false), true);
  assert.equal(shouldLoadEarlier(96, true, false), true);
  assert.equal(shouldLoadEarlier(97, true, false), false);
  assert.equal(shouldLoadEarlier(0, false, false), false);
  assert.equal(shouldLoadEarlier(0, true, true), false, 'one in-flight request at a time');
});

test('a transcript that cannot scroll asks for the next page by itself', () => {
  // An image-only newest page shorter than the viewport: nothing to drag up.
  assert.equal(needsAnotherPage(400, 800, true, false), true);
  assert.equal(needsAnotherPage(800, 800, true, false), true, 'a viewport exactly filled has no scroll range');
  assert.equal(needsAnotherPage(801, 800, true, false), true, 'a one-pixel range is not a usable reading position');
  assert.equal(needsAnotherPage(1600, 800, true, false), false, 'a scrollable transcript waits for the wheel or the button');
  assert.equal(needsAnotherPage(400, 800, false, false), false, 'nothing earlier to load');
  assert.equal(needsAnotherPage(400, 800, true, true), false, 'one in-flight request at a time');
  assert.equal(needsAnotherPage(0, 0, true, false), false, 'a hidden tab does not page the transcript in the background');
});
