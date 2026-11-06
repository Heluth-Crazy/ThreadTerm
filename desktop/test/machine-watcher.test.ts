import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeEvent, Session, Snapshot } from '@threadterm/protocol';
import { machineNotificationFocused, machineNotificationCopy, inboxNotificationCopy } from '../src/inboxNotification.js';
import { MachineTreeStore, MachineWatcher, type WatchClient, type WatchNotice } from '../src/machineWatcher.js';
import { machineTreeKey, type MachineInfo, type MachineTreeFeed } from '../../renderer/src/machineTypes.js';

const machine = (id: string): MachineInfo => ({ id, name: `PC ${id}`, color: '#aabbcc', state: 'connecting' });
const session = (id = 'same'): Session => ({ id, title: 'Session', provider: 'codex', mode: 'chat', status: 'idle', createdAt: 'now', updatedAt: 'now' });
const snapshot = (): Snapshot => ({ epoch: 'epoch', revision: 1, projects: [], sessions: [session()], inbox: [], workspaces: [], settings: { revision: 0 }, providers: [] } as unknown as Snapshot);
const event = (seq: number, name: string, data: unknown): RuntimeEvent => ({ v: 1, epoch: 'epoch', seq, event: name, data });
class FakeClient {
  calls: string[] = []; disposed = false; value = snapshot(); listeners = new Set<(event: RuntimeEvent) => void>();
  request = (async (method: string) => {
    this.calls.push(method);
    if (method === 'runtime.events.filter') return { preset: 'tree', tree: { worktrees: [] } };
    if (method === 'runtime.snapshot') return structuredClone(this.value);
    throw new Error(`Unexpected method ${method}`);
  }) as WatchClient['request'];
  onEvent(listener: (event: RuntimeEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(value: RuntimeEvent) { for (const listener of this.listeners) listener(value); }
  dispose() { this.disposed = true; }
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
test('watcher sets filter then snapshots once, applies events incrementally, reconciles on gap/reconnect', async () => {
  const client = new FakeClient(), notices: WatchNotice[] = [];
  const watcher = new MachineWatcher(machine('a'), client, () => {}, notice => notices.push(notice));
  watcher.start(); await settled();
  assert.deepEqual(client.calls, ['runtime.events.filter', 'runtime.snapshot']);
  client.emit(event(2, 'state.changed', { kind: 'session.title', tree: { session: { ...session(), title: 'Renamed' } } }));
  client.emit(event(3, 'session.activity', { sessionId: 'same', activity: { state: 'awaiting_input', revision: 1 } }));
  client.emit(event(4, 'inbox.created', { id: 'approval', sessionId: 'same', kind: 'approval' }));
  assert.equal(watcher.tree().sessions[0].session.title, 'Renamed');
  assert.equal(watcher.tree().needsYou, 1);
  assert.equal(client.calls.length, 2, 'no per-event RPCs');
  client.value.revision = 4; client.value.sessions[0].title = 'Recovered';
  client.emit(event(5, 'runtime.degraded', { reason: 'gap', snapshotRequired: true })); await settled();
  assert.equal(client.calls.length, 4); assert.equal(watcher.tree().sessions[0].session.title, 'Recovered');
  client.emit(event(0, 'runtime.transport', { state: 'disconnected' }));
  assert.deepEqual(watcher.tree().sessions, []);
  client.emit(event(0, 'runtime.transport', { state: 'reconnected' })); await settled();
  assert.equal(client.calls.length, 6); assert.equal(watcher.tree().machine.state, 'connected');
  watcher.stop(); assert.equal(client.disposed, true);
});
test('machine keys isolate duplicate session ids; expansion and feeds are shared/debounced', async () => {
  const feeds: MachineTreeFeed[] = [], store = new MachineTreeStore(feed => feeds.push(feed), () => {}, 10);
  const a = new FakeClient(), b = new FakeClient();
  store.add(machine('a'), a); store.add(machine('b'), b); await settled();
  await new Promise(resolve => setTimeout(resolve, 20)); feeds.length = 0;
  a.emit(event(2, 'session.status', { sessionId: 'same', status: 'waiting' }));
  assert.equal(store.feed().machines[0].sessions[0].session.status, 'waiting');
  assert.equal(store.feed().machines[1].sessions[0].session.status, 'idle');
  const key = machineTreeKey('a', 'session', 'same');
  assert.notEqual(key, machineTreeKey('b', 'session', 'same'));
  store.expand(key, true); assert.equal(store.feed().expanded[key], true);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(feeds.length, 1);
  store.stop();
});
test('with the gate off no feed is built or sent; turning it on republishes the current feed', async () => {
  let active = false;
  const feeds: MachineTreeFeed[] = [], notices: WatchNotice[] = [];
  const store = new MachineTreeStore(feed => feeds.push(feed), notice => notices.push(notice), 10, () => active);
  const local = new FakeClient(); store.add({ ...machine('local'), state: 'local' }, local, false); await settled();
  local.emit(event(2, 'inbox.created', { id: 'approval', sessionId: 'same', kind: 'approval' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(feeds.length, 0, 'gate off: no feed');
  assert.equal(notices.length, 1, 'gate off: This PC still notifies');
  assert.equal(store.state('local')?.inbox.length, 1);
  active = true; store.republish(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(feeds.length, 1); assert.equal(feeds[0].machines[0].needsYou, 1);
  store.republish(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(feeds.length, 2, 'republish sends even an unchanged feed');
  store.stop();
});
test('notification sequences deduplicate across reconnect and remain independent per machine/epoch', async () => {
  const notices: WatchNotice[] = [], store = new MachineTreeStore(() => {}, notice => notices.push(notice));
  const a = new FakeClient(), b = new FakeClient(); store.add(machine('a'), a); store.add(machine('b'), b); await settled();
  const approval = event(10, 'inbox.created', { id: 'approval', sessionId: 'same', kind: 'approval' });
  a.emit(approval); b.emit(approval); a.emit(approval);
  a.emit(event(0, 'runtime.transport', { state: 'disconnected' }));
  a.emit(event(0, 'runtime.transport', { state: 'reconnected' })); await settled(); a.emit(approval);
  assert.deepEqual(notices.map(notice => notice.machine.id), ['a', 'b']);
  a.value.epoch = 'new'; a.value.revision = 0;
  a.emit(event(0, 'runtime.transport', { state: 'disconnected' }));
  a.emit(event(0, 'runtime.transport', { state: 'reconnected' })); await settled();
  a.emit({ ...approval, epoch: 'new', seq: 1 }); assert.equal(notices.length, 3);
  store.stop();
});
test('removal and gate-off retain only This PC and stop remote clients and late events', async () => {
  const store = new MachineTreeStore(() => {}, () => {}), local = new FakeClient(), a = new FakeClient(), b = new FakeClient();
  store.add(machine('local'), local, false); store.add(machine('a'), a); store.add(machine('b'), b); await settled();
  store.remove('a'); assert.equal(a.disposed, true); assert.equal(a.listeners.size, 0);
  store.retain(new Set(['local'])); assert.equal(b.disposed, true); assert.equal(local.disposed, false);
  assert.deepEqual(store.feed().machines.map(row => row.machine.id), ['local']); store.stop();
});
test('events arriving during a reconnect snapshot reconcile by revision and notify exactly once', async () => {
  const client = new FakeClient(), notices: WatchNotice[] = [];
  const watcher = new MachineWatcher(machine('a'), client, () => {}, notice => notices.push(notice));
  watcher.start(); await settled();
  let resolveSnapshot!: (value: Snapshot) => void;
  client.request = (async (method: string) => method === 'runtime.events.filter' ? { preset: 'tree', tree: { worktrees: [] } } : new Promise<Snapshot>(resolve => { resolveSnapshot = resolve; })) as WatchClient['request'];
  client.emit(event(0, 'runtime.transport', { state: 'disconnected' }));
  client.emit(event(0, 'runtime.transport', { state: 'reconnected' })); await settled();
  client.emit(event(8, 'inbox.created', { id: 'new', sessionId: 'same', kind: 'approval' }));
  const reconciled = snapshot(); reconciled.revision = 8; reconciled.sessions[0].title = 'New snapshot'; resolveSnapshot(reconciled); await settled();
  assert.equal(watcher.tree().sessions[0].session.title, 'New snapshot'); assert.equal(notices.length, 1);
  client.emit(event(8, 'inbox.created', { id: 'new', sessionId: 'same', kind: 'approval' })); assert.equal(notices.length, 1);
  watcher.stop();
});

test('remote notices retain the machine target and machine-prefixed locale copy', async () => {
  const client = new FakeClient(), notices: WatchNotice[] = [];
  const watcher = new MachineWatcher({ ...machine('office'), name: 'Office-PC' }, client, () => {}, notice => notices.push(notice));
  watcher.start(); await settled();
  client.emit(event(3, 'inbox.created', { id: 'approval', sessionId: 'same', kind: 'approval', title: 'Review tests' }));
  assert.equal(notices[0].machine.id, 'office');
  assert.equal((notices[0].event.data as { sessionId: string }).sessionId, 'same');
  const copy = machineNotificationCopy(notices[0].machine.name, inboxNotificationCopy({ kind: 'approval', title: 'Review tests' }, 'zh-CN'));
  assert.equal(copy.title, 'Office-PC · Review tests'); assert.match(copy.body, /批准/);
  watcher.stop();
});
test('resolved inbox metadata updates attention incrementally, without a snapshot', async () => {
  const client = new FakeClient(), watcher = new MachineWatcher(machine('a'), client, () => {}, () => {});
  watcher.start(); await settled();
  client.emit(event(2, 'inbox.created', { id: 'approval', sessionId: 'same', kind: 'approval' }));
  assert.equal(watcher.tree().needsYou, 1);
  client.emit(event(3, 'inbox.resolved', { id: 'approval', tree: { inbox: [] } }));
  assert.equal(watcher.tree().needsYou, 0); assert.equal(client.calls.length, 2); watcher.stop();
});

test('a foreground window suppresses only notifications for the machine being viewed', () => {
  assert.equal(machineNotificationFocused('office', 'local', true), false);
  assert.equal(machineNotificationFocused('office', 'office', true), true);
  assert.equal(machineNotificationFocused('office', 'office', false), false);
  assert.equal(machineNotificationFocused('local', 'office', true), false);
});

test('an unavailable project directory does not take the machine offline or suppress other branches', async () => {
  const client = new FakeClient(); client.value.projects = [{ id: 'missing', name: 'Missing', path: 'C:/missing', createdAt: 'now' }, { id: 'good', name: 'Good', path: 'C:/good', createdAt: 'now' }];
  const base = client.request;
  client.request = (async (method: string, params: { projectId?: string }) => {
    if (method !== 'worktree.list') return base(method as never, params as never);
    if (params.projectId === 'missing') throw new Error('project directory unavailable');
    return [{ id: 'branch', projectId: 'good', path: 'C:/good', branch: 'main', head: '', isMain: true, locked: false, missing: false }];
  }) as WatchClient['request'];
  const watcher = new MachineWatcher(machine('a'), client, () => {}, () => {}); watcher.start(); await settled();
  assert.equal(watcher.tree().machine.state, 'connected'); assert.equal(watcher.tree().worktrees[0].branch, 'main');
  assert.equal(client.calls.filter(method => method === 'runtime.snapshot').length, 1); watcher.stop();
});
test('branch invalidations during an in-flight read get a final incremental read, without snapshots', async () => {
  const client = new FakeClient(); client.value.projects = [{ id: 'project', name: 'Project', path: 'C:/work', createdAt: 'now' }];
  const base = client.request; let reads = 0, release: ((value: unknown) => void) | undefined;
  client.request = (async (method: string, params: unknown) => {
    if (method !== 'worktree.list') return base(method as never, params as never);
    if (++reads === 2) return new Promise(resolve => { release = resolve; });
    return [{ id: 'branch', projectId: 'project', path: 'C:/work', branch: reads > 2 ? 'latest' : 'main', head: '', isMain: true, locked: false, missing: false }];
  }) as WatchClient['request'];
  const watcher = new MachineWatcher(machine('a'), client, () => {}, () => {}); watcher.start(); await settled();
  client.emit(event(2, 'state.changed', { kind: 'git', projectId: 'project' }));
  client.emit(event(3, 'state.changed', { kind: 'git', projectId: 'project' }));
  release!([]); await settled();
  assert.equal(reads, 3); assert.equal(watcher.tree().worktrees[0].branch, 'latest');
  assert.equal(client.calls.filter(method => method === 'runtime.snapshot').length, 1); watcher.stop();
});

test('tree feed keeps only the delegation parent link and state from full snapshots', async () => {
  const client = new FakeClient(); client.value.sessions[0] = { ...session(), nativeId: 'PRIVATE_NATIVE_ID', delegation: { id: 'delegate', parentSessionId: 'parent', workspace: 'shared', state: 'completed', authority: 'full_access', outcome: 'PRIVATE_TRANSCRIPT_PREVIEW' } };
  const watcher = new MachineWatcher(machine('a'), client, () => {}, () => {}); watcher.start(); await settled();
  const sessionTree = watcher.tree().sessions[0]!.session;
  assert.deepEqual(sessionTree.delegation, { parentSessionId: 'parent', state: 'completed' });
  const tree = JSON.stringify(watcher.tree()); assert.doesNotMatch(tree, /PRIVATE_|nativeId|outcome|authority|workspace|delegate/); assert.match(tree, /Session/); watcher.stop();
});
