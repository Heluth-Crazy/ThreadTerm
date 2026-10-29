import assert from 'node:assert/strict';
import test from 'node:test';
import { agentChangesRequestIsCurrent, beginAgentChangesRequest, createAgentChangesCache, finishAgentChangesRequest, refreshAgentChangesCache, resolveAgentChangesWindows } from './agentChangesCache';
import type { ReviewFile } from '@threadterm/protocol';

const ready = (id:string) => ({id, status:'ready' as const});
const files:ReviewFile[] = [{path:'changed.ts', status:'M'}];
const initial = () => resolveAgentChangesWindows(createAgentChangesCache('A'), [ready('one')]);

test('an automatic checkpoint closes the live window and requests its to checkpoint', () => {
 let cache = initial();
 const live = beginAgentChangesRequest(cache, 'one');
 cache = finishAgentChangesRequest(live.cache, live.ticket!, files);
 cache = resolveAgentChangesWindows(refreshAgentChangesCache(cache), [ready('two'), {id:'failed', status:'failed'}, ready('one')]);
 const fixed = beginAgentChangesRequest(cache, 'one');
 assert.notEqual(fixed.ticket!.key, live.ticket!.key);
 assert.deepEqual({from:fixed.ticket!.from, to:fixed.ticket!.to}, {from:'one', to:'two'});
 assert.equal(fixed.cache.rows.one, files, 'old rows stay visible while the new window loads');
});

test('refresh invalidates live data and shares one result between top list and expanded row', () => {
 const first = beginAgentChangesRequest(initial(), 'one');
 let cache = finishAgentChangesRequest(first.cache, first.ticket!, files);
 cache = refreshAgentChangesCache(cache);
 assert.equal(cache.rows.one, files);
 const top = beginAgentChangesRequest(cache, 'one');
 const expanded = beginAgentChangesRequest(top.cache, 'one');
 assert.equal(expanded.ticket, undefined, 'expanded row reuses the top request');
 const latest:ReviewFile[] = [];
 cache = finishAgentChangesRequest(expanded.cache, top.ticket!, latest);
 assert.equal(cache.rows.one, latest);
 assert.equal(cache.entries[top.ticket!.key].files, latest);
});

test('fixed checkpoint pairs are cached across every refresh, including empty lists', () => {
 let cache = resolveAgentChangesWindows(initial(), [ready('two'), ready('one')]);
 const first = beginAgentChangesRequest(cache, 'one');
 cache = finishAgentChangesRequest(first.cache, first.ticket!, []);
 cache = resolveAgentChangesWindows(refreshAgentChangesCache(cache), [ready('three'), ready('two'), ready('one')]);
 assert.equal(beginAgentChangesRequest(cache, 'one').ticket, undefined);
 assert.deepEqual(cache.rows.one, []);
});

test('responses and errors from session A cannot update B or a later A epoch', () => {
 const first = beginAgentChangesRequest(initial(), 'one');
 for(const sessionId of ['B', 'A']) {
  const current = resolveAgentChangesWindows(createAgentChangesCache(sessionId), [ready('one')]);
  assert.equal(agentChangesRequestIsCurrent(current, first.ticket!), false);
  assert.equal(finishAgentChangesRequest(current, first.ticket!, files), current);
  assert.equal(finishAgentChangesRequest(current, first.ticket!), current);
 }
});

test('a late live response is rejected after refresh and after its window closes', () => {
 const first = beginAgentChangesRequest(initial(), 'one');
 const refreshed = beginAgentChangesRequest(refreshAgentChangesCache(first.cache), 'one');
 assert.equal(finishAgentChangesRequest(refreshed.cache, first.ticket!, files), refreshed.cache);
 const closed = resolveAgentChangesWindows(first.cache, [ready('two'), ready('one')]);
 assert.equal(finishAgentChangesRequest(closed, first.ticket!, files), closed);
});

test('fixed requests survive refresh and failures permit retry without removing displayed rows', () => {
 const first = beginAgentChangesRequest(resolveAgentChangesWindows(initial(), [ready('two'), ready('one')]), 'one');
 let cache = refreshAgentChangesCache(first.cache);
 assert.equal(agentChangesRequestIsCurrent(cache, first.ticket!), true);
 cache = finishAgentChangesRequest(cache, first.ticket!, files);
 cache = resolveAgentChangesWindows(cache, [ready('three'), ready('one')]);
 const changed = beginAgentChangesRequest(cache, 'one');
 cache = finishAgentChangesRequest(changed.cache, changed.ticket!);
 assert.equal(cache.rows.one, files);
 assert.ok(beginAgentChangesRequest(cache, 'one').ticket);
});

test('returning to a cached fixed key restores its rows and obsolete pending keys do not block retry', () => {
 let cache = resolveAgentChangesWindows(initial(), [ready('two'), ready('one')]);
 const fixed = beginAgentChangesRequest(cache, 'one');
 cache = finishAgentChangesRequest(fixed.cache, fixed.ticket!, files);
 cache = resolveAgentChangesWindows(cache, [ready('three'), ready('one')]);
 const other = beginAgentChangesRequest(cache, 'one');
 cache = finishAgentChangesRequest(other.cache, other.ticket!, []);
 cache = resolveAgentChangesWindows(cache, [ready('two'), ready('one')]);
 assert.equal(cache.rows.one, files);
 assert.equal(beginAgentChangesRequest(cache, 'one').ticket, undefined);
 const live = beginAgentChangesRequest(initial(), 'one');
 cache = resolveAgentChangesWindows(live.cache, []);
 cache = resolveAgentChangesWindows(cache, [ready('one')]);
 assert.ok(beginAgentChangesRequest(cache, 'one').ticket);
});
