import type { Session, SessionActivity } from '@threadterm/protocol';

export type SessionActivityState = SessionActivity['state'];

// awaiting_parent: a delegated session's request waits for the agent that
// delegated it, so it ranks with running work, not with what needs the user.
const priority: Record<SessionActivityState, number> = { awaiting_approval: 0, awaiting_input: 0, running: 1, awaiting_parent: 1, idle: 2, unknown: 2 };

export function isTerminalAttentionSession(session: Session): boolean {
  return Boolean(session.readOnly || ['exited', 'interrupted', 'error'].includes(session.status));
}

export function sessionActivity(session: Session): SessionActivityState {
  // A snapshot can briefly retain an earlier activity event after a terminal
  // status. Never let that stale event keep the row animated or prioritized.
  if (isTerminalAttentionSession(session)) return 'unknown';
  if (session.activity) return session.activity.state;
  if (session.mode !== 'chat') return 'unknown';
  if (session.status === 'waiting') return 'awaiting_approval';
  if (session.status === 'running') return 'running';
  if (session.status === 'idle') return 'idle';
  return 'unknown';
}

export function sessionActivityLabel(state: SessionActivityState, zh: boolean): string {
  return zh
    ? ({ running: '执行中', awaiting_input: '待继续', awaiting_approval: '待审批', awaiting_parent: '等待委派方', idle: '空闲', unknown: '状态未知' })[state]
    : ({ running: 'Running', awaiting_input: 'Awaiting input', awaiting_approval: 'Awaiting approval', awaiting_parent: 'Waiting for parent agent', idle: 'Idle', unknown: 'Status unknown' })[state];
}

export function canAcknowledgeActivity(session: Session): boolean {
  return sessionActivity(session) === 'awaiting_input';
}

function time(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Sort only sessions in one rendered branch; callers keep project/worktree order intact. */
export function sortSessionsByActivity<T extends Session>(sessions: readonly T[], frozenOrder?: ReadonlyMap<string, number>): T[] {
  return [...sessions].sort((left, right) => {
    if (frozenOrder) {
      const leftOrder = frozenOrder.get(left.id), rightOrder = frozenOrder.get(right.id);
      if (leftOrder !== undefined || rightOrder !== undefined) return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
    }
    return priority[sessionActivity(left)] - priority[sessionActivity(right)]
      || time(right.createdAt) - time(left.createdAt)
      || left.id.localeCompare(right.id);
  });
}

export function activityOrder(sessions: readonly Session[]): Map<string, number> {
  return new Map(sortSessionsByActivity(sessions).map((session, index) => [session.id, index]));
}
