import assert from 'node:assert/strict';
import test from 'node:test';
import type { GroupSummary, ProjectCatalogItem, Worktree } from '@threadterm/protocol';
import { createProjectCatalogStore, projectCatalogStore } from './projectCatalogStore';

type Request = Parameters<typeof createProjectCatalogStore>[0];
const project = (id: string, sortOrder = 0, pinned = false) => ({ id, name: id, path: `C:/${id}`, sortOrder, pinned, git: { available: false } } as ProjectCatalogItem);
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(run: (method: string, params: { projectId?: string }) => Promise<unknown>) {
  const pending = new Map<number, { run: () => void; delay: number }>(); let serial = 0;
  const store = createProjectCatalogStore(run as Request, {
    schedule: (run, delay) => { const id = ++serial; pending.set(id, { run, delay }); return id; },
    cancel: timer => { pending.delete(timer as number); },
  });
  const tick = () => { const queued = [...pending.values()]; pending.clear(); queued.forEach(timer => timer.run()); };
  return { store, pending, tick };
}

test('a slow worktree and a failing worktree cannot hide any project or another project’s details', async () => {
  const slow = deferred<Worktree[]>(); let failures = 0;
  const healthyTree = { id: 'main', projectId: 'healthy', path: 'C:/healthy', branch: 'main' } as Worktree;
  const { store, pending, tick } = setup(async (method, params) => {
    if (method === 'project.catalog.list') return [project('slow', 2), project('bad', 1), project('healthy', 3, true)];
    if (method === 'group.list') return [];
    if (params.projectId === 'slow') return slow.promise;
    if (params.projectId === 'bad' && failures++ === 0) throw new Error('worktree failed');
    return params.projectId === 'healthy' ? [healthyTree] : [];
  });
  const stop = store.activate(); await flush();
  assert.deepEqual(store.getSnapshot().items.map(row => row.id), ['healthy', 'bad', 'slow']);
  assert.deepEqual(store.getSnapshot().trees.healthy, [healthyTree]);
  assert.equal(store.getSnapshot().loaded, true); assert.equal(store.getSnapshot().loading, false);
  assert.match(store.getSnapshot().issue!, /worktree failed/); assert.equal(pending.size, 1);
  tick(); await flush(); assert.equal(store.getSnapshot().issue, undefined);
  slow.resolve([]); await flush(); assert.deepEqual(store.getSnapshot().trees.slow, []);
  stop(); assert.equal(pending.size, 0);
});

test('a failed first catalog load retries without waiting for a reconnect event', async () => {
  let calls = 0;
  const { store, pending, tick } = setup(async method => {
    if (method !== 'project.catalog.list') return [];
    if (++calls === 1) throw new Error('temporary disconnect');
    return [project('restored')];
  });
  const stop = store.activate(); await flush();
  assert.equal(store.getSnapshot().loaded, false); assert.equal(pending.size, 1);
  tick(); await flush(); assert.equal(calls, 2); assert.equal(store.getSnapshot().items[0].id, 'restored');
  stop();
});

// Owner report 2026-11-16: Git made project.catalog.list run past the request timeout and the sidebar lost every project.
// The runtime now answers within its Git budget and marks a repository it is still reading as pending.
test('a project whose Git facts are still being read is listed at once and the list is asked for again', async () => {
  let calls = 0;
  const { store, pending, tick } = setup(async method => {
    if (method !== 'project.catalog.list') return [];
    calls += 1;
    return [{ ...project('repo'), git: calls === 1 ? { available: false, pending: true } : { available: true, branch: 'main' } } as ProjectCatalogItem];
  });
  const stop = store.activate(); await flush();
  assert.equal(store.getSnapshot().items[0].id, 'repo'); assert.equal(store.getSnapshot().issue, undefined);
  assert.equal(pending.size, 1, 'a follow-up list is scheduled');
  tick(); await flush();
  assert.equal(calls, 2); assert.equal(store.getSnapshot().items[0].git.branch, 'main');
  assert.equal(pending.size, 0, 'nothing pending, nothing scheduled');
  stop();
});

test('a cancelled first load retries, ignores its late response, and reconnect reloads immediately', async () => {
  const first = deferred<ProjectCatalogItem[]>(); let calls = 0;
  const { store, tick } = setup(async method => method === 'project.catalog.list' ? (++calls === 1 ? first.promise : [project('current')]) : []);
  const stop = store.activate(); store.transport('disconnected'); tick(); await flush();
  assert.equal(store.getSnapshot().items[0].id, 'current');
  first.resolve([project('obsolete')]); await flush(); assert.equal(store.getSnapshot().items[0].id, 'current');
  store.transport('reconnected'); await flush(); assert.equal(calls, 3); stop();
});

test('remount immediately sees the last projects, trees and groups while its fresh list is pending', async () => {
  const next = deferred<ProjectCatalogItem[]>(); let calls = 0;
  const tree = { id: 'tree' } as Worktree, group = { id: 'group' } as GroupSummary;
  const { store } = setup(async method => method === 'project.catalog.list' ? (++calls === 1 ? [project('cached')] : next.promise) : method === 'worktree.list' ? [tree] : [group]);
  const stop = store.activate(); await flush(); stop();
  const cached = store.getSnapshot();
  const stopAgain = store.activate();
  assert.equal(store.getSnapshot().items, cached.items); assert.equal(store.getSnapshot().trees.cached[0], tree);
  assert.equal(store.getSnapshot().groups.cached[0], group);
  next.resolve([]); await flush(); assert.deepEqual(store.getSnapshot().items, []); assert.deepEqual(store.getSnapshot().trees, {}); stopAgain();
});

test('unmount cancels retries and obsolete responses cannot overwrite the next mount', async () => {
  const first = deferred<ProjectCatalogItem[]>(); let calls = 0;
  const { store, pending } = setup(async method => method === 'project.catalog.list' ? (++calls === 1 ? first.promise : [project('new')]) : []);
  const stop = store.activate(); store.transport('incompatible'); assert.equal(pending.size, 1); stop(); assert.equal(pending.size, 0);
  const stopAgain = store.activate(); await flush(); first.resolve([project('old')]); await flush();
  assert.deepEqual(store.getSnapshot().items.map(row => row.id), ['new']); stopAgain();
});

test('group failure and late group refresh do not hide worktrees or overwrite newer groups', async () => {
  const old = deferred<GroupSummary[]>(); let calls = 0;
  const tree = { id: 'tree' } as Worktree, group = { id: 'fresh' } as GroupSummary;
  const { store } = setup(async method => method === 'project.catalog.list' ? [project('one')] : method === 'worktree.list' ? [tree] : (++calls === 1 ? old.promise : [group]));
  const stop = store.activate(); await flush(); store.reloadGroups(); await flush();
  old.resolve([{ id: 'obsolete' } as GroupSummary]); await flush();
  assert.equal(store.getSnapshot().trees.one[0], tree); assert.equal(store.getSnapshot().groups.one[0], group); stop();
});

test('retries back off to ten seconds and do not multiply for the same failed load', async () => {
  const { store, pending, tick } = setup(async () => { throw new Error('offline'); });
  const stop = store.activate(); await flush();
  for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
    assert.equal(pending.size, 1); assert.equal([...pending.values()][0].delay, delay); tick(); await flush();
  }
  stop(); assert.equal(pending.size, 0);
});

// 11-19: on a cold start where Git is slow the list is asked for again while branch lists are still being read.
test('a branch list in flight when the list reloads is kept, and read once more after it answers', async () => {
  const first = deferred<Worktree[]>(); let reads = 0;
  const tree = (branch: string) => ({ id: branch, projectId: 'repo', path: `C:/repo-${branch}`, branch } as Worktree);
  const { store } = setup(async method => {
    if (method === 'project.catalog.list') return [project('repo')];
    if (method === 'group.list') return [];
    return ++reads === 1 ? first.promise : [tree('second')];
  });
  const shown: string[] = [];
  store.subscribe(() => { const rows = store.getSnapshot().trees.repo?.map(row => row.branch).join(); if (rows && shown.at(-1) !== rows) shown.push(rows); });
  const stop = store.activate(); await flush();
  void store.reload(); await flush(); void store.reload(); await flush();
  assert.equal(reads, 1, 'one read in flight at a time');
  first.resolve([tree('first')]); await flush();
  assert.equal(reads, 2, 'one more read for both reloads');
  assert.deepEqual(shown, ['first', 'second'], 'the answer in flight is shown, then the newer one');
  stop();
});

test('listing again while Git is being read asks only for details not read yet', async () => {
  let lists = 0; const calls: string[] = [];
  const { store, pending, tick } = setup(async (method, params) => {
    calls.push(`${method}:${params.projectId ?? ''}`);
    if (method === 'project.catalog.list') return [{ ...project('repo'), git: ++lists === 1 ? { available: false, pending: true } : { available: true, branch: 'main' } } as ProjectCatalogItem];
    return [];
  });
  const stop = store.activate(); await flush();
  assert.deepEqual([...calls].sort(), ['group.list:repo', 'project.catalog.list:', 'worktree.list:repo']);
  calls.length = 0; tick(); await flush();
  assert.deepEqual(calls, ['project.catalog.list:'], 'the branch list and groups are not read again');
  assert.equal(store.getSnapshot().items[0].git.branch, 'main'); assert.equal(pending.size, 0);
  stop();
});

test('a project that leaves the list takes its failing read with it: no issue, no retry', async () => {
  const read = deferred<Worktree[]>(); let lists = 0;
  const { store, pending } = setup(async method => {
    if (method === 'project.catalog.list') return ++lists === 1 ? [project('gone')] : [];
    if (method === 'group.list') return [];
    return read.promise;
  });
  const stop = store.activate(); await flush();
  await store.reload(); read.reject(new Error('project not found')); await flush();
  assert.equal(store.getSnapshot().issue, undefined); assert.equal(pending.size, 0);
  assert.deepEqual(store.getSnapshot().trees, {}); assert.deepEqual(store.getSnapshot().answered, {});
  stop();
});

test('a branch list or groups read counts as answered when it loads and when it fails', async () => {
  const { store } = setup(async method => {
    if (method === 'project.catalog.list') return [project('repo')];
    if (method === 'group.list') throw new Error('groups unavailable');
    return [];
  });
  const stop = store.activate(); await flush();
  assert.deepEqual(store.getSnapshot().answered, { 'trees:repo': true, 'groups:repo': true });
  assert.deepEqual(store.getSnapshot().trees.repo, []); assert.equal(store.getSnapshot().groups.repo, undefined);
  stop();
});

test('a bridge that throws instead of rejecting answers the read and keeps the next one possible', async () => {
  let reads = 0;
  const { store, pending, tick } = setup((method => {
    if (method === 'project.catalog.list') return Promise.resolve([project('repo')]);
    if (method === 'group.list') return Promise.resolve([]);
    if (++reads === 1) throw new Error('bridge gone');
    return Promise.resolve([]);
  }) as Parameters<typeof setup>[0]);
  const stop = store.activate(); await flush();
  assert.equal(store.getSnapshot().answered['trees:repo'], true); assert.match(store.getSnapshot().issue!, /bridge gone/);
  assert.equal(pending.size, 1, 'retried like a rejection'); tick(); await flush();
  assert.deepEqual(store.getSnapshot().trees.repo, []); assert.equal(store.getSnapshot().issue, undefined);
  stop();
});

test('cache identity is stable within a machine and isolated between machines', () => {
  const request = (async () => []) as Request;
  assert.equal(projectCatalogStore('a', request), projectCatalogStore('a', request));
  assert.notEqual(projectCatalogStore('a', request), projectCatalogStore('b', request));
});
