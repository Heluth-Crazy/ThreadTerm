import { isRecord, type CatalogVisibility, type InboxItem, type Project, type RuntimeEvent, type Session, type Settings, type Snapshot, type Worktree } from '@threadterm/protocol';
import type { MachineInfo, MachineTree, MachineTreeFeed, MachineTreeSession } from '../../renderer/src/machineTypes.js';
import type { RuntimeClient } from './runtime-client.js';

export type WatchClient = Pick<RuntimeClient, 'request' | 'onEvent' | 'dispose'>;
export interface WatchState { visibility: CatalogVisibility[]; projects: Project[]; sessions: Session[]; worktrees: Worktree[]; inbox: InboxItem[]; settings?: Settings; providers: Snapshot['providers'] }
/** Public tree metadata only, including when the initial full snapshot had richer session fields. */
function treeSession(session: Session): MachineTreeSession['session'] {
  const { id, title, provider, mode, status, createdAt, updatedAt, projectId, worktreePath, exitCode, readOnly, archived, activity, terminalAgent } = session;
  const delegation = session.delegation && { parentSessionId: session.delegation.parentSessionId, state: session.delegation.state };
  return { id, title, provider, mode, status, createdAt, updatedAt, projectId, worktreePath, exitCode, readOnly, archived, activity, terminalAgent, delegation };
}
export interface WatchNotice { machine: MachineInfo; event: RuntimeEvent; state: WatchState }

/** A connection-scoped subscription. Only connection/recovery paths request snapshots. */
export class MachineWatcher {
  readonly state: WatchState = { visibility: [], projects: [], sessions: [], worktrees: [], inbox: [], providers: [] };
  private stopped = false;
  private ready = false;
  private connectionLost = false;
  private generation = 0;
  private syncing?: Promise<void>;
  private syncAgain = false;
  private buffered: RuntimeEvent[] = [];
  private readonly refreshingWorktrees = new Set<string>();
  private readonly dirtyWorktrees = new Set<string>();
  private epoch = '';
  private revision = 0;
  // Separate from projection revision: a live event may already be represented in the snapshot.
  private readonly notified = new Map<string, number>();
  private unsubscribe: () => void;
  constructor(readonly machine: MachineInfo, private readonly client: WatchClient,
    private readonly changed: () => void, private readonly notify: (notice: WatchNotice) => void,
    private readonly ownsClient = true) {
    this.unsubscribe = client.onEvent(event => this.receive(event));
  }
  start(): void { void this.reconcile(); }
  stop(): void {
    this.stopped = true; this.generation++; this.unsubscribe(); this.buffered = [];
    if (this.ownsClient) this.client.dispose();
  }
  private receive(event: RuntimeEvent): void {
    if (this.stopped) return;
    if (event.event === 'runtime.transport') {
      const data = isRecord(event.data) ? event.data : {};
      if (data.state === 'reconnected') {
        if (this.syncing && !this.connectionLost) return; // The start request established this connection.
        this.connectionLost = false;
        void this.reconcile();
      } else {
        this.connectionLost = true; this.generation++; this.ready = false;
        this.machine.state = data.state === 'incompatible' ? 'incompatible' : data.state === 'pin-mismatch' ? 'pin-mismatch' : 'disconnected';
        this.machine.message = String(data.message ?? data.reason ?? ''); this.changed();
      }
      return;
    }
    if (event.event === 'runtime.degraded') {
      const data = isRecord(event.data) ? event.data : {};
      if (data.snapshotRequired === true || data.reason === 'chat_event_too_large') void this.reconcile();
      return;
    }
    if (!this.ready || this.syncing) {
      // Bounded buffering: overflow is a projection gap, never unbounded main memory.
      if (this.buffered.length < 1024) this.buffered.push(event);
      else { this.buffered = []; this.generation++; this.syncAgain = true; }
      return;
    }
    this.apply(event);
  }
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    const generation = this.generation;
    this.syncing = (async () => {
      try {
        const filter = await this.client.request('runtime.events.filter', { preset: 'tree' });
        const snapshot = await this.client.request('runtime.snapshot', {});
        if (this.stopped || generation !== this.generation) return;
        Object.assign(this.state, { projects: snapshot.projects, sessions: snapshot.sessions, inbox: snapshot.inbox,
          settings: snapshot.settings, providers: snapshot.providers, worktrees: filter.tree.worktrees, visibility: filter.tree.visibility ?? [] });
        for (const project of snapshot.projects) {
          const worktrees = await this.client.request('worktree.list', { projectId: project.id }).catch(() => filter.tree.worktrees.filter(tree => tree.projectId === project.id));
          if (this.stopped || generation !== this.generation) return;
          this.state.worktrees = [...this.state.worktrees.filter(tree => tree.projectId !== project.id), ...worktrees];
        }
        this.epoch = snapshot.epoch; this.revision = snapshot.revision; this.ready = true;
        this.machine.state = this.machine.id === 'local' ? 'local' : 'connected'; this.machine.message = undefined;
        for (const event of this.buffered.splice(0)) this.apply(event);
        this.changed();
      } catch {
        if (!this.stopped && generation === this.generation) { this.ready = false; this.machine.state = 'disconnected'; this.changed(); }
      }
    })().finally(() => {
      this.syncing = undefined;
      if (this.syncAgain && !this.stopped) { this.syncAgain = false; void this.reconcile(); }
    });
    return this.syncing;
  }
  private apply(event: RuntimeEvent): void {
    if (event.epoch !== this.epoch && event.seq > 0) { void this.reconcile(); return; }
    const data = isRecord(event.data) ? event.data : {};
    if (event.seq > this.revision) {
      this.revision = event.seq;
      const tree = isRecord(data.tree) ? data.tree : {};
      for (const key of ['projects', 'sessions', 'worktrees', 'inbox', 'visibility'] as const) {
        if (Array.isArray(tree[key])) (this.state[key] as unknown[]) = tree[key];
      }
      if (isRecord(tree.settings)) this.state.settings = tree.settings as Settings;
      if (isRecord(tree.session)) {
        const session = tree.session as unknown as Session;
        this.state.sessions = [...this.state.sessions.filter(item => item.id !== session.id), session];
      }
      if (event.event === 'session.status' || event.event === 'session.activity') {
        this.state.sessions = this.state.sessions.map(session => session.id !== data.sessionId ? session : {
          ...session, ...(event.event === 'session.status' ? { status: data.status as Session['status'], exitCode: data.exitCode as number | undefined } : { activity: data.activity as Session['activity'] }),
        });
      }
      if (event.event === 'inbox.created' && typeof data.id === 'string') {
        const item = { ...data, read: false } as unknown as InboxItem;
        this.state.inbox = [...this.state.inbox.filter(row => row.id !== item.id), item];
      }
      if (event.event === 'state.changed' && (Array.isArray(tree.projects) || data.kind === 'git')) {
        const ids = typeof data.projectId === 'string' ? [data.projectId] : this.state.projects.map(project => project.id);
        for (const id of ids) void this.refreshWorktrees(id);
      }
      if (event.event !== 'runtime.cursor') this.changed();
    }
    if (event.seq <= 0 || !['session.status', 'inbox.created'].includes(event.event)) return;
    const notified = this.notified.get(event.epoch) ?? 0;
    if (event.seq <= notified) return;
    this.notified.set(event.epoch, event.seq); // Fence before asynchronous OS delivery.
    this.notify({ machine: this.machine, event, state: this.state });
  }
  private async refreshWorktrees(projectId: string): Promise<void> {
    if (this.refreshingWorktrees.has(projectId)) { this.dirtyWorktrees.add(projectId); return; }
    const generation = this.generation;
    this.refreshingWorktrees.add(projectId);
    try {
      const worktrees = await this.client.request('worktree.list', { projectId });
      if (this.stopped || generation !== this.generation || !this.state.projects.some(project => project.id === projectId)) return;
      this.state.worktrees = [...this.state.worktrees.filter(tree => tree.projectId !== projectId), ...worktrees]; this.changed();
    } catch { /* A reconnect snapshot reconciles unavailable scopes. */ }
    finally {
      this.refreshingWorktrees.delete(projectId);
      if (this.dirtyWorktrees.delete(projectId) && !this.stopped) void this.refreshWorktrees(projectId);
    }
  }
  tree(): MachineTree {
    const online = this.machine.state === 'local' || this.machine.state === 'connected';
    const visible = (kind: CatalogVisibility['kind'], id: string) => !this.state.visibility.some(row => row.kind === kind && row.id === id && row.visibility !== 'active');
    const projects = online ? this.state.projects.filter(project => visible('project', project.id)) : [];
    const worktrees = online ? this.state.worktrees.filter(tree => visible('worktree', tree.id) && projects.some(project => project.id === tree.projectId)) : [];
    const sessions = online ? this.state.sessions.filter(session => !session.archived && visible('session', session.id) && (!session.projectId || projects.some(project => project.id === session.projectId)) && !this.state.worktrees.some(tree => tree.path === session.worktreePath && !visible('worktree', tree.id))).map(session => ({ session: treeSession(session), needsYou: Math.max(
      this.state.inbox.filter(item => item.sessionId === session.id && !item.read).length,
      ['awaiting_approval', 'awaiting_input'].includes(session.activity?.state ?? '') ? 1 : 0,
    ) })) : [];
    return { machine: { ...this.machine }, projects, worktrees,
      sessions, needsYou: sessions.reduce((sum, row) => sum + row.needsYou, 0) };
  }
}

/** One main-owned projection and expansion map, shared by all app renderers. */
export class MachineTreeStore {
  private readonly watchers = new Map<string, MachineWatcher>();
  private readonly expanded: Record<string, boolean> = {};
  private timer?: ReturnType<typeof setTimeout>;
  private lastPublished = '';
  /** `active` false (the gate is off): watchers keep notifying, but no feed is built or sent. */
  constructor(private readonly publish: (feed: MachineTreeFeed) => void,
    private readonly notify: (notice: WatchNotice) => void, private readonly debounceMs = 250,
    private readonly active: () => boolean = () => true) {}
  private changed = () => {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.active()) return;
      const feed = this.feed(), serialized = JSON.stringify(feed);
      if (serialized !== this.lastPublished) { this.lastPublished = serialized; this.publish(feed); }
    }, this.debounceMs);
  };
  add(machine: MachineInfo, client: WatchClient, ownsClient = true): MachineWatcher {
    this.remove(machine.id);
    const watcher = new MachineWatcher({ ...machine }, client, this.changed, this.notify, ownsClient);
    this.watchers.set(machine.id, watcher); watcher.start(); this.changed(); return watcher;
  }
  has(id: string): boolean { return this.watchers.has(id); }
  state(id: string): WatchState | undefined { return this.watchers.get(id)?.state; }
  /** Sends the current feed even if unchanged, e.g. when the gate turns on after feeds were withheld. */
  republish(): void { this.lastPublished = ''; this.changed(); }
  remove(id: string): void { this.watchers.get(id)?.stop(); this.watchers.delete(id); this.changed(); }
  retain(ids: Set<string>): void { for (const id of this.watchers.keys()) if (!ids.has(id)) this.remove(id); }
  expand(key: string, value: boolean): void { this.expanded[key] = value; this.changed(); }
  feed(): MachineTreeFeed { return { machines: [...this.watchers.values()].map(watcher => watcher.tree()), expanded: { ...this.expanded } }; }
  stop(): void { for (const watcher of this.watchers.values()) watcher.stop(); this.watchers.clear(); clearTimeout(this.timer); this.timer = undefined; }
}
