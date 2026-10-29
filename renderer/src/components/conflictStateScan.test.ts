import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictRefreshDebouncer, ConflictStateScheduler, MAX_CONFLICT_STATE_PATHS, eventTouchesPaths, shouldDebounceConflictRefresh } from './conflictStateScan';
import type { ConflictSavedState } from '../workbench/conflictStage';

const clear: ConflictSavedState = {kind: 'clear'};

test('conflict state scans run no more than four reads at once', async () => {
  const scheduler = new ConflictStateScheduler(4);
  let active = 0, maximum = 0;
  const states = await scheduler.scan(Array.from({length: 12}, (_, index) => `f${index}`), async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--; return clear;
  }, () => true);
  assert.equal(maximum, 4);
  assert.equal(Object.keys(states).length, 12);
});

test('a superseded scan launches no queued stale reads and shares the concurrency limit', async () => {
  const scheduler = new ConflictStateScheduler(1);
  let current = true;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const read: string[] = [];
  const first = scheduler.scan(['old-active', 'old-queued'], async path => {
    read.push(path); await blocked; return clear;
  }, () => current);
  await new Promise(resolve => setTimeout(resolve, 0));
  current = false;
  const second = scheduler.scan(['new'], async path => { read.push(path); return clear; }, () => true);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(read, ['old-active', 'new']);
});

test('the scan caps reads at one hundred and marks remaining paths unknown', async () => {
  const scheduler = new ConflictStateScheduler();
  let reads = 0;
  const paths = Array.from({length: MAX_CONFLICT_STATE_PATHS + 2}, (_, index) => `f${index}`);
  const states = await scheduler.scan(paths, async () => { reads++; return clear; }, () => true);
  assert.equal(reads, MAX_CONFLICT_STATE_PATHS);
  assert.deepEqual(states.f100, {kind: 'unknown'});
  assert.deepEqual(states.f101, {kind: 'unknown'});
});

test('a special object key remains an own state entry', async () => {
  const states = await new ConflictStateScheduler().scan(['__proto__'], async () => clear, () => true);
  assert.equal(Object.hasOwn(states, '__proto__'), true);
  assert.deepEqual(states.__proto__, clear);
});

test('detailed file events refresh only intersecting paths while pathless events remain eligible', () => {
  assert.equal(eventTouchesPaths(new CustomEvent('files', {detail: {path: 'a.ts'}}), ['a.ts']), true);
  assert.equal(eventTouchesPaths(new CustomEvent('files', {detail: {paths: ['else.ts']}}), ['a.ts']), false);
  assert.equal(eventTouchesPaths(new Event('files'), ['a.ts']), true);
  assert.equal(shouldDebounceConflictRefresh(new Event('files'), ['a.ts']), true);
  assert.equal(shouldDebounceConflictRefresh(new CustomEvent('files', {detail: {paths: []}}), ['a.ts']), true);
  assert.equal(shouldDebounceConflictRefresh(new CustomEvent('files', {detail: {path: 'a.ts'}}), ['a.ts']), false);
});

test('pathless refreshes reset one timer and an immediate refresh cancels it', () => {
  let callback: (() => void) | undefined, scheduled = 0, cancelled = 0, refreshed = 0;
  const debouncer = new ConflictRefreshDebouncer(300,
    fn => { scheduled++; callback = fn; return fn as unknown as ReturnType<typeof setTimeout>; },
    () => { cancelled++; },
  );
  debouncer.schedule(() => { refreshed++; });
  debouncer.schedule(() => { refreshed++; });
  assert.equal(scheduled, 2);
  assert.equal(cancelled, 1);
  debouncer.cancel();
  assert.equal(cancelled, 2);
  assert.equal(refreshed, 0);
  debouncer.schedule(() => { refreshed++; });
  callback!();
  assert.equal(refreshed, 1);
});
