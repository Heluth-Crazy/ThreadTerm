import type { ChatItem, ChatPart, Session } from '@threadterm/protocol';
import type { MachineTree } from '../../renderer/src/machineTypes.js';
import type { IslandItem, IslandLiveState } from '../../renderer/src/island/model.js';

export type { IslandItem, IslandLiveState, IslandState } from '../../renderer/src/island/model.js';

/* The task island's decisions, kept free of Electron so they can be tested: which sessions it shows, since when,
   which finished ones it announces, and when it is on screen. Owner design 2026-11-16 (prototypes/task-island). */

export interface IslandPreferences { enabled: boolean; alert: boolean; toasts: boolean; badge: boolean }

/** `settings.notifications`: the runtime keeps only boolean keys there, so the island's switches live beside the toast ones. */
export function islandPreferences(value: unknown): IslandPreferences {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { enabled: source.island !== false, alert: source.islandAlert !== false, toasts: source.islandToasts === true, badge: source.taskbarBadge !== false };
}

/** The island's own window carries session events; toasts stay quiet unless the user wants both. */
export function islandHandlesToasts(preferences: IslandPreferences, lightweight: boolean): boolean {
  return preferences.enabled && !lightweight && !preferences.toasts;
}

/** Shown only while ThreadTerm is not in front, something is on it, and no full-screen app or presentation runs. */
export function islandVisible(input: { preferences: IslandPreferences; lightweight: boolean; appFocused: boolean; fullscreen: boolean; items: number }): boolean {
  return input.preferences.enabled && !input.lightweight && !input.appFocused && !input.fullscreen && input.items > 0;
}

/** `system.notificationState` words that mean a full-screen app, game or presentation has the screen. */
export function fullscreenState(state: unknown): boolean {
  return state === 'busy' || state === 'fullscreen' || state === 'presentation';
}

export type TaskbarBadge = 'needs' | 'running' | undefined;
export function taskbarBadge(items: readonly IslandItem[]): TaskbarBadge {
  if (items.some(item => item.state === 'approval' || item.state === 'input')) return 'needs';
  return items.some(item => item.state === 'running') ? 'running' : undefined;
}

export const islandKey = (machineId: string, sessionId: string) => `${machineId}\u0000${sessionId}`;

/**
 * What a session is doing now, for the island. Ended, read-only and plain idle sessions show nothing. `input` is the
 * runtime's `awaiting_input`, which also means "a Chat turn finished and its reply is unread": the tracker shows it only
 * once a pending request for the user is read from the transcript (see `IslandTracker.items`).
 */
export function liveState(session: Pick<Session, 'readOnly' | 'status' | 'activity' | 'mode'>): IslandLiveState | undefined {
  if (session.readOnly || ['exited', 'interrupted', 'error'].includes(session.status)) return undefined;
  const state = session.activity?.state ?? (session.mode !== 'chat' ? undefined : session.status === 'waiting' ? 'awaiting_approval' : session.status === 'running' ? 'running' : undefined);
  return state === 'running' ? 'running' : state === 'awaiting_approval' ? 'approval' : state === 'awaiting_input' ? 'input' : undefined;
}

export interface IslandSource {
  key: string; machineId: string; sessionId: string; machineName?: string; mode: Session['mode'];
  title: string; project?: string; provider: string; providerName: string; state: IslandLiveState;
  /** When the runtime last touched the session: the start estimate for a turn already running at launch. */
  updatedAt: number;
}

/**
 * The sessions one computer contributes. Only visible, unarchived sessions (the sidebar's own tree). A delegated
 * agent's or a code reviewer's running turn belongs to the agent that started it, so only their requests for the
 * user show; every top-level running, waiting or asking session shows.
 */
export function islandSources(tree: MachineTree, raw: readonly Session[], providers: readonly { id: string; name?: string }[]): IslandSource[] {
  const remote = tree.machine.id !== 'local';
  const sources: IslandSource[] = [];
  for (const { session } of tree.sessions) {
    if (session.archived) continue;
    const state = liveState(session);
    if (!state) continue;
    const full = raw.find(item => item.id === session.id);
    if (state === 'running' && (session.delegation || full?.codeReview)) continue;
    const provider = session.terminalAgent ?? session.provider;
    const updated = Date.parse(session.updatedAt);
    sources.push({
      key: islandKey(tree.machine.id, session.id), machineId: tree.machine.id, sessionId: session.id, machineName: remote ? tree.machine.name : undefined,
      mode: session.mode, title: session.title, project: tree.projects.find(project => project.id === session.projectId)?.name, provider,
      providerName: providers.find(item => item.id === session.provider)?.name || session.provider, state, updatedAt: Number.isFinite(updated) ? updated : 0,
    });
  }
  return sources;
}

/** Remembers since when each session runs or waits, and which finished turns the island is still announcing. */
export class IslandTracker {
  private readonly live = new Map<string, { state: IslandLiveState; since: number; started: number; source: IslandSource }>();
  /** Sessions that just left the island: a reply arrives a moment after the activity goes idle. */
  private readonly recent = new Map<string, { started: number; until: number; source: IslandSource }>();
  private readonly finished = new Map<string, IslandItem & { until: number }>();
  private readonly approvals = new Map<string, ChatPart>();
  /** A finished session's mode, kept after it left the live map so its reply can still be read. */
  private readonly modes = new Map<string, Session['mode']>();

  /** Applies the current sessions; returns the keys that newly need the user (their approval part is worth reading). */
  update(sources: readonly IslandSource[], now: number): string[] {
    const fresh: string[] = [];
    const present = new Set(sources.map(source => source.key));
    for (const [key, entry] of this.live) {
      if (present.has(key)) continue;
      this.live.delete(key); this.approvals.delete(key);
      this.recent.set(key, { started: entry.started, until: now + 60_000, source: entry.source });
    }
    for (const source of sources) {
      const entry = this.live.get(source.key);
      if (!entry) {
        const recent = this.recent.get(source.key);
        // A turn already running when the island first looks started no later than the session's last update.
        const started = recent?.started ?? (source.state === 'running' && source.updatedAt > 0 ? Math.min(now, source.updatedAt) : now);
        this.recent.delete(source.key); this.modes.delete(source.key);
        this.live.set(source.key, { state: source.state, since: source.state === 'running' ? started : now, started, source });
        // A finished announcement is over once the session works again. A reply can reach the island before the
        // activity update that ends the turn, so an unchanged `updatedAt` is not a new turn; an approval always is. A
        // finished turn itself reads as `input`, so `input` replaces the card only once a request is read (`setApproval`).
        const announced = this.finished.get(source.key);
        if (announced && (source.state === 'approval' || (source.state === 'running' && source.updatedAt > announced.since + 1000))) this.finished.delete(source.key);
        if (source.state !== 'running') fresh.push(source.key);
        continue;
      }
      entry.source = source;
      if (entry.state === source.state) continue;
      // The request read for the old state no longer describes the session; a new wait is read again.
      this.approvals.delete(source.key);
      // An approval outranks the finished card that may still hide this entry (see `items`); `input` waits for its read.
      if (source.state !== 'running') { fresh.push(source.key); if (source.state === 'approval') this.finished.delete(source.key); }
      entry.state = source.state;
      entry.since = source.state === 'running' ? entry.started : now;
    }
    for (const [key, entry] of this.recent) if (entry.until <= now) this.recent.delete(key);
    return fresh;
  }

  /** The pending request read for a waiting session. For `input` it is what makes the session need the user at all. */
  setApproval(key: string, part: ChatPart | undefined): boolean {
    const entry = this.live.get(key);
    if (!entry || entry.state === 'running') return false;
    if (part) { this.approvals.set(key, part); this.finished.delete(key); } else this.approvals.delete(key);
    return true;
  }

  /** Whether a live session asks something of the user: an approval, or an `input` wait with a request read for it. */
  needsUser(key: string): boolean {
    const entry = this.live.get(key);
    return !!entry && (entry.state === 'approval' || entry.state === 'input' && this.approvals.has(key));
  }

  /** Announces a finished turn of a session the island saw working; false for any other session. */
  finish(key: string, state: 'done' | 'error', now: number, ttlMs: number): boolean {
    const entry = this.live.get(key) ?? this.recent.get(key);
    const announced = this.finished.get(key);
    if (!entry) {
      // A second notice about the turn already on screen: the island shows one card per finished turn.
      if (!announced) return false;
      announced.state = state; announced.since = now; announced.until = now + ttlMs;
      return true;
    }
    const source = entry.source;
    // The turn is over: the session is no longer running on the island, and the announcement is what it shows now.
    this.live.delete(key); this.recent.delete(key); this.approvals.delete(key); this.modes.set(key, source.mode);
    this.finished.set(key, { key, machineId: source.machineId, sessionId: source.sessionId, machineName: source.machineName, title: source.title, project: source.project,
      provider: source.provider, providerName: source.providerName, state, since: now, started: entry.started, until: now + ttlMs });
    return true;
  }

  setResult(key: string, result: string | undefined): boolean {
    const item = this.finished.get(key);
    if (!item || !result) return false;
    item.result = result;
    return true;
  }


  /** Keeps every finished announcement on screen until at least `until`; never shortens one. */
  hold(until: number): void {
    for (const item of this.finished.values()) item.until = Math.max(item.until, until);
  }

  /** Drops finished announcements whose time is up; true when something left. */
  expire(now: number): boolean {
    let changed = false;
    for (const [key, item] of this.finished) if (item.until <= now) { this.finished.delete(key); this.modes.delete(key); changed = true; }
    return changed;
  }
  nextExpiry(): number | undefined {
    let next: number | undefined;
    for (const item of this.finished.values()) next = next === undefined ? item.until : Math.min(next, item.until);
    return next;
  }

  items(): IslandItem[] {
    // `input` without a request is a finished turn whose reply is unread: the Inbox does not count it, nor does the island.
    const live = [...this.live.values()].filter(entry => !this.finished.has(entry.source.key) && (entry.state !== 'input' || this.approvals.has(entry.source.key))).map(({ state, since, started, source }): IslandItem => ({
      key: source.key, machineId: source.machineId, sessionId: source.sessionId, machineName: source.machineName, title: source.title, project: source.project,
      provider: source.provider, providerName: source.providerName, state, since, started, approval: this.approvals.get(source.key),
    }));
    const finished = [...this.finished.values()].map(({ until: _until, ...item }) => item);
    return [...live, ...finished].sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
  }
  /** The live sessions' mode, for callers deciding whether a Chat transcript can be read. */
  mode(key: string): Session['mode'] | undefined { return (this.live.get(key) ?? this.recent.get(key))?.source.mode ?? this.modes.get(key); }
}

/** The newest pending approval in a page of Chat items, trimmed to what the island page needs to word it. */
export function pendingApproval(items: readonly ChatItem[], maxBytes = 24_000): ChatPart | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const parts = items[index]!.parts;
    for (let part = parts.length - 1; part >= 0; part -= 1) {
      const candidate = parts[part]!;
      if (candidate.type !== 'approval' || candidate.status !== 'pending') continue;
      if (JSON.stringify(candidate).length <= maxBytes) return candidate;
      // A large diff or plan: keep the request's identity and title, drop the bulk.
      const data = candidate.data && typeof candidate.data === 'object' && !Array.isArray(candidate.data) ? candidate.data as Record<string, unknown> : {};
      return { type: 'approval', approvalId: candidate.approvalId, status: candidate.status, data: { approvalId: data.approvalId, title: data.title, interaction: data.interaction, requestType: data.requestType } };
    }
  }
  return undefined;
}

/** One line for a finished turn: the error's message, else the last answer's first sentence. */
export function resultLine(items: readonly ChatItem[], state: 'done' | 'error', max = 90): string | undefined {
  const last = [...items].reverse();
  let text: string | undefined;
  if (state === 'error') {
    for (const item of last) {
      const error = [...item.parts].reverse().find(part => part.type === 'error' && typeof part.text === 'string' && part.text.trim());
      if (error) { text = error.text; break; }
    }
  } else {
    const answer = last.find(item => item.role === 'assistant' && item.parts.some(part => part.type === 'text' && part.text?.trim()));
    if (answer) {
      const parts = answer.parts.filter(part => part.type === 'text' && part.text?.trim());
      text = (parts.filter(part => part.phase === 'final_answer').at(-1) ?? parts.at(-1))?.text;
    }
  }
  if (!text) return undefined;
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]+/g, ' ')
    .split(/\r?\n/).map(line => line.replace(/^\s*(?:[-+]|\d+[.)])\s+/, '').trim()).filter(Boolean)[0];
  if (!plain) return undefined;
  const line = plain.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
