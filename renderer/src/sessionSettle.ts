import type { CatalogVisibility, Session } from '@threadterm/protocol';
import { operationId, request } from './bridge';
import { isLiveSession } from './sessionRelease';

/**
 * 收尾 (settle), owner 11-24 after T3 Code's Settle: a finished session leaves the project tree for the sidebar's
 * 「已收尾」 shelf, and its process is stopped. It is the catalogue's `archived` visibility for a session; the shelf
 * replaces the endless "Archived sessions" list in the worktree menu. A session that starts working again comes
 * back on its own; sessions quiet for `sessions.autoSettleDays` (default 7) settle automatically.
 */
export const AUTO_SETTLE_DEFAULT_DAYS = 7;
export const AUTO_SETTLE_CHOICES = [3, 7, 14, 30, 0] as const;
export const SETTLED_PAGE = 10;
export const SETTLED_OPEN_KEY = 'threadterm.catalog.settled-open';
const DAY_MS = 24 * 60 * 60 * 1000;
const WORKING_ACTIVITY = ['running', 'awaiting_approval', 'awaiting_input', 'awaiting_parent'];
const ACTIVE_DELEGATION = ['starting', 'running', 'awaiting_parent', 'awaiting_user', 'cancelling', 'cancel_failed'];

export type SettleSession = Pick<Session, 'id' | 'title' | 'status' | 'mode' | 'readOnly' | 'activity' | 'delegation' | 'updatedAt' | 'pinned' | 'followed' | 'archived' | 'organizationRevision' | 'projectId' | 'provider' | 'nativeId'>;

export function autoSettleDays(value: unknown): number {
  return typeof value === 'number' && (AUTO_SETTLE_CHOICES as readonly number[]).includes(value) ? value : AUTO_SETTLE_DEFAULT_DAYS;
}

/** Working: a turn runs, or it waits for someone. Such a session is never settled, by hand or automatically. */
export function sessionWorking(session: Pick<Session, 'status' | 'mode' | 'activity' | 'delegation' | 'readOnly'>): boolean {
  if (session.readOnly) return false;
  if (session.status === 'starting' || (session.mode === 'chat' && (session.status === 'running' || session.status === 'waiting'))) return true;
  if (WORKING_ACTIVITY.includes(session.activity?.state ?? '')) return true;
  return ACTIVE_DELEGATION.includes(session.delegation?.state ?? '');
}

/** The session and the delegates it started (and theirs): they settle and come back together. */
export function settleGroup<T extends Pick<Session, 'id' | 'delegation'>>(id: string, sessions: readonly T[]): T[] {
  const root = sessions.find(session => session.id === id);
  if (!root) return [];
  const group = [root], seen = new Set([id]);
  for (let index = 0; index < group.length; index++) {
    for (const child of sessions) {
      if (child.delegation?.parentSessionId === group[index].id && !seen.has(child.id)) { seen.add(child.id); group.push(child); }
    }
  }
  return group;
}

const visibilityOf = (visibility: readonly CatalogVisibility[], id: string) =>
  visibility.find(row => row.kind === 'session' && row.id === id)?.visibility ?? 'active';

/** The shelf: settled sessions, most recently active first. Delegates stay with their parent and are not listed. */
export function settledSessions<T extends SettleSession>(sessions: readonly T[], visibility: readonly CatalogVisibility[], projectActive: (projectId: string) => boolean): T[] {
  const settled = sessions.filter(session => visibilityOf(visibility, session.id) === 'archived' && session.projectId && projectActive(session.projectId));
  const ids = new Set(settled.map(session => session.id));
  return settled
    .filter(session => !session.delegation || !ids.has(session.delegation.parentSessionId))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

/**
 * Sessions to settle automatically: in the tree (visible, project active), not pinned or followed, not a delegate
 * (it goes with its parent), quiet for `days`, and neither it nor any of its delegates working. A live session must
 * be one ThreadTerm can stop and continue later; a shell it could only end stays where it is.
 */
export function autoSettleCandidates<T extends SettleSession>(sessions: readonly T[], visibility: readonly CatalogVisibility[], options: {
  now: number; days: number; projectActive: (projectId: string) => boolean; canRelease: (session: T) => boolean;
}): T[] {
  if (!options.days) return [];
  const cutoff = options.now - options.days * DAY_MS;
  return sessions.filter(session => {
    if (session.delegation || session.pinned || session.followed || session.archived || !session.projectId) return false;
    if (visibilityOf(visibility, session.id) !== 'active' || !options.projectActive(session.projectId)) return false;
    const quietSince = Date.parse(session.updatedAt);
    if (!Number.isFinite(quietSince) || quietSince > cutoff) return false;
    const group = settleGroup(session.id, sessions);
    return group.every(member => !sessionWorking(member) && (!isLiveSession(member) || options.canRelease(member)));
  });
}

/** Why this session cannot be settled by hand right now, or undefined. */
export function settleBlockedReason(group: readonly Pick<Session, 'status' | 'mode' | 'activity' | 'delegation' | 'readOnly' | 'title'>[], zh: boolean): string | undefined {
  const working = group.filter(sessionWorking);
  if (!working.length) return undefined;
  const names = working.map(session => session.title).join(zh ? '、' : ', ');
  return zh ? `${names} 正在工作或在等待处理，完成后再收尾。` : `${names} ${working.length === 1 ? 'is' : 'are'} working or waiting for an answer. Settle once done.`;
}

/**
 * Settles a session with its delegates: stops what still runs (release keeps the conversation resumable; a terminal
 * ThreadTerm cannot continue later is ended, as the owner asked: 收尾就停掉), then hides them from the tree.
 */
export async function settleSessions(ids: readonly string[], zh: boolean): Promise<void> {
  const before = await request('runtime.snapshot', {});
  const group = ids.map(id => before.sessions.find(session => session.id === id)).filter((session): session is Session => Boolean(session));
  const blocked = settleBlockedReason(group, zh);
  if (blocked) throw new Error(blocked);
  // The runtime releases all or none. A session it cannot continue later (a plain shell) is refused for that reason
  // only; those are ended instead and the rest released again. Any other refusal (busy, a pending request) stops here.
  let live = group.filter(isLiveSession).map(session => session.id);
  for (let attempt = 0; live.length && attempt < 2; attempt++) {
    const result = await request('session.releaseResources.bulk', { sessionIds: live, operationId: operationId() });
    if (!result.refused.length) break;
    const endable = result.refused.filter(entry => /no native session id|cannot resume a terminal/i.test(entry.message));
    if (attempt === 1 || endable.length !== result.refused.length) {
      const names = result.refused.map(entry => group.find(session => session.id === entry.sessionId)?.title ?? entry.sessionId).join(zh ? '、' : ', ');
      throw new Error(zh ? `${names} 现在无法停止，稍后再收尾。` : `${names} cannot be stopped right now. Settle again later.`);
    }
    for (const entry of endable) await request('session.stop', { sessionId: entry.sessionId, force: true, operationId: operationId() });
    live = live.filter(id => !endable.some(entry => entry.sessionId === id));
  }
  const [visibility, after] = await Promise.all([request('catalog.visibility.list', {}), request('runtime.snapshot', {})]);
  for (const id of ids) {
    const session = after.sessions.find(row => row.id === id);
    if (!session) continue;
    const entry = visibility.find(row => row.kind === 'session' && row.id === id);
    if (entry?.visibility === 'archived') continue;
    await request('catalog.visibility.update', { kind: 'session', id, visibility: 'archived', expectedRevision: entry?.revision ?? session.organizationRevision ?? 0, operationId: operationId() });
  }
}

/** Brings settled sessions back to the tree. Their processes stay stopped until they are opened. */
export async function unsettleSessions(ids: readonly string[]): Promise<void> {
  const [visibility, snapshot] = await Promise.all([request('catalog.visibility.list', {}), request('runtime.snapshot', {})]);
  for (const id of ids) {
    const entry = visibility.find(row => row.kind === 'session' && row.id === id);
    if (!entry || entry.visibility !== 'archived') continue;
    const session = snapshot.sessions.find(row => row.id === id);
    await request('catalog.visibility.update', { kind: 'session', id, visibility: 'active', expectedRevision: entry.revision ?? session?.organizationRevision ?? 0, operationId: operationId() });
  }
}
