import type { GroupMemberState, GroupSummary, Session } from '@threadterm/protocol';

/** A lazy group summary paired with its visible member Chat sessions. */
export type CatalogGroup = { group: GroupSummary; members: Session[] };

/** Group-member sessions are represented by their parent group, never twice. */
export function groupMemberIds(groups: readonly GroupSummary[]): Set<string> {
  return new Set(groups.flatMap(group => group.members.map(member => member.sessionId)));
}

/** Joins summaries to active Chat sessions while preserving the runtime's member order. */
export function catalogGroups(groups: readonly GroupSummary[], sessions: readonly Session[]): CatalogGroup[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  return [...groups]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(group => ({
      group,
      members: group.members.flatMap(member => {
        const session = byId.get(member.sessionId);
        return session && !session.archived ? [session] : [];
      }),
    }));
}

export type GroupCatalogState = 'working' | 'needs' | 'failed' | 'idle';

type SummaryMember = GroupSummary['members'][number];

function memberState(member: SummaryMember, sessions: readonly Session[]): GroupMemberState {
  const session = sessions.find(session => session.id === member.sessionId), activity = session?.activity?.state;
  if (activity === 'awaiting_approval') return 'needs_user';
  if (activity === 'awaiting_input') {
    if (session?.status === 'waiting') return 'needs_user';
    return member.state === 'needs_user' ? 'idle' : member.state;
  }
  if (activity === 'running' || activity === 'awaiting_parent') return 'working';
  return member.state;
}

export function groupCatalogState(members: readonly SummaryMember[], sessions: readonly Session[] = []): GroupCatalogState {
  const states = members.map(member => memberState(member, sessions));
  if (states.includes('needs_user')) return 'needs';
  if (states.includes('failed')) return 'failed';
  if (states.includes('working') || states.includes('queued')) return 'working';
  return 'idle';
}

export function groupCatalogLabel(members: readonly SummaryMember[], zh: boolean, sessions: readonly Session[] = []): string {
  const states = members.map(member => memberState(member, sessions));
  const needs = states.filter(state => state === 'needs_user').length;
  if (needs) return zh ? '需要你处理' : 'Needs you';
  const working = states.filter(state => state === 'working' || state === 'queued').length;
  if (working) return zh ? `${working} 个进行中` : `${working} working`;
  const failed = states.filter(state => state === 'failed').length;
  if (failed) return zh ? `${failed} 个失败` : `${failed} failed`;
  return zh ? '空闲' : 'Idle';
}

/** Maps aggregate group state to the shared, iconless status-chip vocabulary. */
export function groupCatalogStatusClass(state: GroupCatalogState): string {
  if (state === 'working') return 'chip st-running';
  if (state === 'needs') return 'chip st-needs';
  if (state === 'failed') return 'chip st-failed';
  return 'chip flat';
}

export function groupMemberLabel(handle: string): string {
  return `@${handle}`;
}
