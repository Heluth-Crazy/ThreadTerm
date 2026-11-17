import type { ChatItem, InboxItem, Session } from '@threadterm/protocol';
import { toolView, type ToolStatus } from './toolView';

/**
 * R15/R17: the pure model behind the 待处理 workbench. A goal is a top-level Chat
 * (no delegation of its own, not archived) with at least one child delegation. It owns
 * the decisions its parent and children raised, and the acceptance rows of children that
 * finished and nobody has accepted yet. No React, no RPC: the page only draws this.
 */
export type DecisionItem = { item: InboxItem; session: Session };
export type Acceptance = { child: Session; delegationId: string };
export type GoalActivity = { child: Session; at: string };

export type InboxGoal = {
  parent: Session;
  /** Children, newest change first. */
  children: Session[];
  /** Actionable approval items (`kind === 'approval'`): drawn as inline cards. */
  decisions: DecisionItem[];
  /** Actionable items of every other kind: one-line rows that open the session. */
  notices: DecisionItem[];
  /** Completed children without an acceptance decision. */
  acceptances: Acceptance[];
  /** Children this user already accepted or sent back. */
  processed: number;
  activity?: GoalActivity;
  /** Everything that still needs the user in this goal. */
  pending: number;
};

export type OtherGroup = { session: Session; decisions: DecisionItem[]; notices: DecisionItem[]; pending: number };

export type InboxWorkbench = { goals: InboxGoal[]; other: OtherGroup[]; pending: number; processed: number };

const byNewest = (left: { updatedAt: string }, right: { updatedAt: string }) => right.updatedAt.localeCompare(left.updatedAt);

/** A chat the user gave a goal to, rather than a delegate or a finished session. */
export function isGoalParent(session: Session): boolean {
  return session.mode === 'chat' && !session.delegation && !session.archived;
}

/** The runtime's live delegation states (`delegation::LIVE_STATES`): the subtask is not over yet. */
export const LIVE_DELEGATION_STATES: readonly string[] = ['starting', 'running', 'awaiting_parent', 'awaiting_user', 'cancelling', 'cancel_failed'];

/** A delegate that still waits for a decision, or already got one. */
function isPendingAcceptance(child: Session): boolean {
  return child.delegation?.state === 'completed' && !child.delegation.acceptance;
}

/** R15: the two kinds of thing the user handles here; `stalled`/`reply` stay elsewhere. */
function isActionable(item: InboxItem): boolean {
  return !item.read && item.kind !== 'stalled' && item.kind !== 'reply';
}

/**
 * R15: goals in reading order — the ones with a pending decision first, then by the
 * newest change among their children. `includeGoalIds` keeps a Chat the composer just
 * created visible before its first delegate exists (R16 keeps the user on this page).
 */
export function inboxWorkbench(input: {
  sessions: readonly Session[];
  inbox: readonly InboxItem[];
  includeGoalIds?: readonly string[];
}): InboxWorkbench {
  const { sessions, inbox } = input;
  const byId = new Map(sessions.map(session => [session.id, session]));
  const children = new Map<string, Session[]>();
  for (const session of sessions) {
    const parentId = session.delegation?.parentSessionId;
    if (!parentId || session.archived) continue;
    const rows = children.get(parentId);
    if (rows) rows.push(session); else children.set(parentId, [session]);
  }
  const include = new Set(input.includeGoalIds ?? []);
  const goalIds: string[] = [];
  for (const session of sessions) {
    if (!isGoalParent(session)) continue;
    if ((children.get(session.id)?.length ?? 0) > 0 || include.has(session.id)) goalIds.push(session.id);
  }
  // An extra id only matters when the caller also listed its session (the composer
  // keeps the Chat it just created in the session list until the snapshot catches up).
  const parents = goalIds.map(id => byId.get(id)).filter((session): session is Session => Boolean(session));

  const pendingItems = inbox.filter(isActionable);
  const decisions = new Map<string, DecisionItem[]>();
  const notices = new Map<string, DecisionItem[]>();
  for (const item of pendingItems) {
    const session = byId.get(item.sessionId);
    if (!session) continue;
    const target = item.kind === 'approval' ? decisions : notices;
    const rows = target.get(item.sessionId);
    if (rows) rows.push({ item, session }); else target.set(item.sessionId, [{ item, session }]);
  }

  const inGoal = new Set<string>();
  const goals: InboxGoal[] = parents.map(parent => {
    const own = children.get(parent.id) ?? [];
    inGoal.add(parent.id);
    for (const child of own) inGoal.add(child.id);
    const ids = new Set([parent.id, ...own.map(child => child.id)]);
    const goalDecisions = [...ids].flatMap(id => decisions.get(id) ?? []);
    const goalNotices = [...ids].flatMap(id => notices.get(id) ?? []);
    const acceptances = own.filter(isPendingAcceptance).map(child => ({ child, delegationId: child.delegation!.id }));
    const newest = [...own].sort(byNewest)[0];
    return {
      parent,
      children: [...own].sort(byNewest),
      decisions: goalDecisions.sort((left, right) => right.item.createdAt.localeCompare(left.item.createdAt)),
      notices: goalNotices.sort((left, right) => right.item.createdAt.localeCompare(left.item.createdAt)),
      acceptances,
      processed: own.filter(child => Boolean(child.delegation?.acceptance)).length,
      ...(newest ? { activity: { child: newest, at: newest.updatedAt } } : null),
      pending: goalDecisions.length + goalNotices.length + acceptances.length,
    };
  });
  // A goal stays on the page while it needs the user or a subtask is still live; one whose
  // subtasks are all over and handled leaves it (the Chat stays in the sidebar), so the page
  // does not grow with every chat that ever delegated.
  const visible = goals.filter(goal => goal.pending > 0
    || goal.children.some(child => LIVE_DELEGATION_STATES.includes(child.delegation?.state ?? ''))
    || include.has(goal.parent.id));
  visible.sort((left, right) => {
    const decision = Number(right.decisions.length > 0) - Number(left.decisions.length > 0);
    if (decision) return decision;
    return (right.activity?.at ?? right.parent.updatedAt).localeCompare(left.activity?.at ?? left.parent.updatedAt);
  });

  const otherSessions = new Map<string, Session>();
  for (const [sessionId, rows] of [...decisions, ...notices]) {
    if (inGoal.has(sessionId)) continue;
    const session = rows[0]?.session;
    if (session) otherSessions.set(sessionId, session);
  }
  const other: OtherGroup[] = [...otherSessions].map(([sessionId, session]) => {
    const groupDecisions = decisions.get(sessionId) ?? [];
    const groupNotices = notices.get(sessionId) ?? [];
    return { session, decisions: groupDecisions, notices: groupNotices, pending: groupDecisions.length + groupNotices.length };
  }).sort((left, right) => {
    const newest = (group: OtherGroup) => [...group.decisions, ...group.notices].map(row => row.item.createdAt).sort().at(-1) ?? group.session.updatedAt;
    return newest(right).localeCompare(newest(left));
  });

  return {
    goals: visible,
    other,
    pending: visible.reduce((sum, goal) => sum + goal.pending, 0) + other.reduce((sum, group) => sum + group.pending, 0),
    processed: visible.reduce((sum, goal) => sum + goal.processed, 0),
  };
}

export type AcceptanceEvidence = { command: string; status: ToolStatus; exitCode?: number; failed: boolean };

/**
 * R15: the pending approval or question a decision item stands for. The inbox id is the
 * chat item id; when that item no longer carries a pending part, the newest pending part
 * of the session is used instead.
 */
export function pendingApprovalOf(items: readonly ChatItem[], itemId: string): { item: ChatItem; part: ChatItem['parts'][number] } | undefined {
  const exact = items.find(item => item.id === itemId);
  const order = exact ? [exact, ...[...items].reverse()] : [...items].reverse();
  for (const item of order) {
    const part = item.parts.find(candidate => candidate.type === 'approval' && candidate.status === 'pending');
    if (part) return { item, part };
  }
  return undefined;
}

/**
 * R15: the run record of a delegate's turn, taken from its own tool calls rather than
 * from the model's own account. The delegated turn is the first user item's turn.
 */
export function acceptanceEvidence(items: readonly ChatItem[], max = 2): AcceptanceEvidence[] {
  const turn = items.find(item => item.role === 'user');
  const turnId = turn?.turnId;
  const scoped = turnId ? items.filter(item => item.turnId === turnId) : turn ? [turn] : [];
  const commands: AcceptanceEvidence[] = [];
  for (const item of scoped) {
    for (const part of item.parts) {
      if (part.type !== 'tool') continue;
      const view = toolView(part);
      if (view.kind !== 'command') continue;
      const exitCode = view.exitCode;
      commands.push({
        command: view.display || view.command,
        status: view.status,
        exitCode,
        failed: view.status === 'failed' || (exitCode !== undefined && exitCode !== 0),
      });
    }
  }
  return commands.slice(-Math.max(0, max));
}
