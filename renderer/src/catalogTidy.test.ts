import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session, Worktree } from '@threadterm/protocol';
import {
  activeDelegateParents,
  branchOrder,
  foldSummary,
  foldedSummaryLabel,
  foldExpanded,
  foldKey,
  orderBranchSessions,
  orderBranches,
  orderRecentCandidates,
  recentRows,
  relativeTime,
  splitBranchSessions,
  foldableBranches,
  worktreeLabel,
  readCatalogFolds,
  writeCatalogFolds,
  setCatalogFold,
  boundedCatalogFolds,
  CATALOG_FOLD_KEY,
  readCatalogView,
  writeCatalogView,
  CATALOG_VIEW_KEY,
  selectedAncestors,
  uniqueWorktrees,
} from './catalogTidy';

const now = Date.parse('2026-11-16T20:30:00Z');
const session = (id: string, createdHoursAgo: number, extra: Partial<Session> = {}): Session => ({
  id, title: id, projectId: 'p1', provider: 'codex', mode: 'chat', status: 'idle',
  createdAt: new Date(now - createdHoursAgo * 3600_000).toISOString(),
  updatedAt: new Date(now - createdHoursAgo * 3600_000).toISOString(),
  activity: { state: 'idle', revision: 1 }, ...extra,
});
const running = (id: string, createdHoursAgo = 0): Session => session(id, createdHoursAgo, { status: 'running', activity: { state: 'running', revision: 1 } });
const waiting = (id: string, createdHoursAgo = 0): Session => session(id, createdHoursAgo, { status: 'waiting', activity: { state: 'awaiting_approval', revision: 1 } });
const tree = (id: string, branch: string | null, path: string, extra: Partial<Worktree> = {}): Worktree => ({
  id, projectId: 'p1', path, branch, head: 'abc', isMain: false, locked: false, missing: false, ...extra,
});
const ids = (sessions: readonly Session[]) => sessions.map(row => row.id);
const names = (trees: readonly Worktree[]) => trees.map(row => row.branch ?? row.path);
const byId = (trees: readonly Worktree[], sessions: readonly Session[]) => (value: Worktree) =>
  sessions.filter(row => row.worktreePath === value.path);

test('R4: worktree names use the branch, else the folder, else the parent folder; main keeps the local name', () => {
  assert.equal(worktreeLabel(tree('t1', 'feat/mac', 'D:/work/tt-mac'), 'D:/project/ThreadTerm-v3', '本地目录'), 'feat/mac');
  assert.equal(worktreeLabel(tree('t2', null, 'D:/work/tt-issue48-base'), 'D:/project/ThreadTerm-v3', '本地目录'), 'tt-issue48-base');
  assert.equal(worktreeLabel(tree('t3', null, 'D:/work/audit/ThreadTerm-v3'), 'D:/project/ThreadTerm-v3', '本地目录'), 'audit');
  assert.equal(worktreeLabel(tree('t4', null, 'D:/project/ThreadTerm-v3', { isMain: true }), 'D:/project/ThreadTerm-v3', '本地目录'), '本地目录');
  assert.equal(worktreeLabel(tree('t5', 'main', 'D:/project/ThreadTerm-v3', { isMain: true }), 'D:/project/ThreadTerm-v3', '本地目录'), 'main');
  assert.equal(worktreeLabel(tree('t6', null, 'D:\\work\\audit\\ThreadTerm-V3'), 'D:/project/ThreadTerm-v3', 'Local directory'), 'audit');
});

test('a folder the runtime holds twice (a deleted worktree under two path spellings) is listed once', () => {
  const canonical = tree('a', 'feat/zeta', '\\\\?\\D:\\work\\tidy-missing', { missing: true });
  const gitSpelling = tree('b', 'feat/zeta', 'D:/work/tidy-missing', { missing: true });
  const other = tree('c', 'feat/alpha', 'D:/work/alpha');
  assert.deepEqual(uniqueWorktrees([canonical, other, gitSpelling]).map(row => row.id), ['a', 'c']);
  const back = tree('d', 'feat/zeta', 'd:\\work\\tidy-missing\\');
  assert.deepEqual(uniqueWorktrees([canonical, back]).map(row => row.id), ['d'], 'the row whose folder exists wins');
});

test('R4: branches are main first, then by newest session, then name', () => {
  const trees = [
    tree('b', 'feature/b', 'D:/b'), tree('a', 'feature/a', 'D:/a'),
    tree('main', 'main', 'D:/main', { isMain: true }), tree('c', 'feature/c', 'D:/c'),
    tree('d', 'feature/d', 'D:/d'),
  ];
  const sessions = [session('a1', 3, { worktreePath: 'D:/a' }), session('b1', 1, { worktreePath: 'D:/b' }),
    session('d1', 1, { worktreePath: 'D:/d' }), session('main1', 99, { worktreePath: 'D:/main' })];
  assert.deepEqual(names(orderBranches(trees, byId(trees, sessions))), ['main', 'feature/b', 'feature/d', 'feature/a', 'feature/c']);
});

test('R3: empty and unused deleted worktrees fold, the current and live ones never fold', () => {
  const trees = [
    tree('main', 'main', 'D:/main', { isMain: true }), tree('live', 'feature/live', 'D:/live'),
    tree('empty', 'feature/empty', 'D:/empty'), tree('deleted', 'feature/deleted', 'D:/deleted', { missing: true }),
    tree('deletedLive', 'feature/deleted-live', 'D:/deleted-live', { missing: true }),
    tree('current', 'feature/current', 'D:/current'), tree('ended', 'feature/ended', 'D:/ended'),
  ];
  const sessions = [
    session('live1', 1, { worktreePath: 'D:/live', status: 'running', activity: { state: 'running', revision: 1 } }),
    session('deletedLive1', 1, { worktreePath: 'D:/deleted-live', activity: { state: 'awaiting_input', revision: 1 } }),
    session('ended1', 2, { worktreePath: 'D:/ended', status: 'exited' }),
    session('main1', 3, { worktreePath: 'D:/main' }),
  ];
  const split = foldableBranches(trees, byId(trees, sessions), { isCurrent: value => value.id === 'current' });
  assert.deepEqual(split.other.map(value => value.id), ['empty', 'deleted']);
  assert.deepEqual(split.listed.map(value => value.id), ['main', 'live', 'deletedLive', 'current', 'ended']);
});

test('R5/R6: needs-you first, then creation order; running/idle activity never moves a row', () => {
  const rows = [session('new', 1), waiting('wait', 5), session('old', 9), running('run', 3)];
  assert.deepEqual(ids(orderBranchSessions(rows)), ['wait', 'new', 'run', 'old']);
  const before = ids(orderBranchSessions(rows));
  const changed = rows.map(row => row.id === 'run' ? { ...row, status: 'idle' as const, activity: { state: 'idle' as const, revision: 2 } } : row);
  assert.deepEqual(ids(orderBranchSessions(changed)), before);
  const frozen = new Map([['old', 0], ['new', 1], ['run', 2], ['wait', 3]]);
  assert.deepEqual(ids(orderBranchSessions(rows, frozen)), ['old', 'new', 'run', 'wait']);
});

test('an open menu freezes exactly the shown order (11-19: a running older chat jumped above a newer idle one)', () => {
  // Newer idle above older running: the order the tree shows.
  const rows = [running('driving', 9), session('readonly', 1), session('golden', 5)];
  const shown = ids(orderBranchSessions(rows));
  assert.deepEqual(shown, ['readonly', 'golden', 'driving']);
  // Frozen from every chat of the catalog, it keeps each branch's own order, even while activity changes.
  const frozen = branchOrder([...rows, waiting('elsewhere', 2)]);
  assert.deepEqual(ids(orderBranchSessions(rows, frozen)), shown);
  const changed = rows.map(row => row.id === 'readonly' ? { ...row, status: 'waiting' as const, activity: { state: 'awaiting_approval' as const, revision: 2 } } : row);
  assert.deepEqual(ids(orderBranchSessions(changed, frozen)), shown, 'a chat that needs you while the menu is open does not move');
  assert.deepEqual(ids(orderBranchSessions(changed))[0], 'readonly', 'after the menu closes it moves up as usual');
});

test('R5: waiting, running, selected, followed and active parents pin; 3 newest others show; the rest fold', () => {
  const rows = [session('new', 1), session('two', 2), session('three', 3), session('four', 4), session('five', 5),
    waiting('needs', 8), running('runs', 9), session('picked', 10), session('star', 11, { followed: true })];
  const parents = new Set(['parent']);
  const withParent = [...rows, session('parent', 12), session('child', 13, { delegation: { id: 'd', parentSessionId: 'parent', workspace: 'shared', state: 'running' } })];
  assert.deepEqual([...activeDelegateParents(withParent)], ['parent']);
  const topLevel = withParent.filter(row => !row.delegation);
  const split = splitBranchSessions(orderBranchSessions(topLevel), { selectedId: 'picked', activeDelegateParents: parents });
  assert.deepEqual(ids(split.shown), ['needs', 'new', 'two', 'three', 'runs', 'picked', 'star', 'parent']);
  assert.deepEqual(ids(split.older), ['four', 'five']);
  const noParent = splitBranchSessions(orderBranchSessions([...topLevel, session('late', 14)]), { activeDelegateParents: new Set() });
  assert.deepEqual(ids(noParent.older), ['four', 'five', 'picked', 'parent', 'late']);
});

test('R5/R6: an unread reply stays shown in place; only an approval moves up and counts as needing you', () => {
  const replied = (id: string, createdHoursAgo: number) => session(id, createdHoursAgo, { activity: { state: 'awaiting_input', revision: 1 } });
  const rows = [session('a', 1), session('b', 2), session('c', 3), session('d', 4), replied('reply', 9), waiting('approve', 10)];
  const ordered = orderBranchSessions(rows);
  assert.deepEqual(ids(ordered), ['approve', 'a', 'b', 'c', 'd', 'reply'], 'the reply keeps its creation place');
  const turnEnds = rows.map(row => row.id === 'a' ? { ...row, activity: { state: 'awaiting_input' as const, revision: 2 } } : row);
  assert.deepEqual(ids(orderBranchSessions(turnEnds)), ids(ordered), 'a turn ending does not move its row');
  const split = splitBranchSessions(ordered);
  assert.ok(ids(split.shown).includes('reply'), 'an unread reply is never folded away');
  assert.deepEqual(ids(split.older), ['d']);
  assert.deepEqual(foldSummary([replied('r', 1), session('s', 2)]), { kind: 'count', count: 2 }, 'replies do not count as needing you');
});

test('R5: a selected delegate keeps its parent chain shown and pinned', () => {
  const rows = [session('a', 1), session('b', 2), session('c', 3), session('d', 4), session('e', 5),
    session('parent', 9), session('delegate', 10, { delegation: { id: 'd', parentSessionId: 'parent', workspace: 'shared', state: 'completed' } })];
  assert.deepEqual([...selectedAncestors(rows, 'delegate')], ['parent']);
  const split = splitBranchSessions(orderBranchSessions(rows), { selectedId: 'delegate', activeDelegateParents: selectedAncestors(rows, 'delegate') });
  assert.ok(ids(split.shown).includes('parent'));
  assert.ok(ids(split.shown).includes('delegate'));
});

test('R1: a fold summary prefers needs count, then running, then the plain count', () => {
  assert.deepEqual(foldSummary([waiting('a'), waiting('b'), running('c')]), { kind: 'needs', count: 2 });
  assert.deepEqual(foldSummary([running('a'), session('b', 1)]), { kind: 'running' });
  assert.deepEqual(foldSummary([session('a', 1), session('b', 2)]), { kind: 'count', count: 2 });
  assert.equal(foldSummary([]), undefined);
  assert.equal(foldedSummaryLabel(foldSummary([waiting('a')]), true), '1 项需要你');
  assert.equal(foldedSummaryLabel(foldSummary([waiting('a')]), false), '1 needs you');
});

test('R7: recent rows sort by updatedAt, group by day, cap at 40 and hide delegated sessions unless they wait', () => {
  const today = new Date(now);
  const yesterday = new Date(now - 36 * 3600_000);
  const earlier = new Date(now - 5 * 24 * 3600_000);
  const candidate = (id: string, at: Date, extra: Partial<Session> = {}) => ({ session: { ...session(id, 0), updatedAt: at.toISOString(), ...extra }, where: `Project · ${id}` });
  const rows = [
    candidate('old', earlier), candidate('today', today), candidate('yesterday', yesterday),
    candidate('delegate', today, { delegation: { id: 'd', parentSessionId: 'today', workspace: 'shared', state: 'completed' } }),
    candidate('waitingDelegate', today, { status: 'waiting', activity: { state: 'awaiting_approval', revision: 2 },
      delegation: { id: 'd2', parentSessionId: 'today', workspace: 'shared', state: 'running' } }),
    candidate('archived', today, { archived: true }),
  ];
  const output = recentRows(rows, { now, zh: false });
  assert.equal(output.some(row => row.kind === 'session' && row.session.id === 'delegate'), false, 'a delegate lives under its parent unless it waits');
  assert.ok(output.some(row => row.kind === 'session' && row.session.id === 'waitingDelegate'));
  assert.ok(output.some(row => row.kind === 'day' && row.label === 'Today'));
  assert.ok(output.some(row => row.kind === 'day' && row.label === 'Yesterday'));
  assert.ok(output.some(row => row.kind === 'day' && row.label === 'Earlier'));
  assert.equal(output.filter(row => row.kind === 'session').length, 4);
  assert.equal(output.filter(row => row.kind === 'session').some(row => row.kind === 'session' && row.session.id === 'archived'), false);
  const many = Array.from({ length: 50 }, (_, index) => candidate(`s${index}`, new Date(now - index * 1000)));
  assert.equal(recentRows(many, { now, zh: false }).filter(row => row.kind === 'session').length, 40);
  assert.equal(orderRecentCandidates(many)[0].session.id, 's0');
});

test('R7: relative time words in both languages', () => {
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
  assert.equal(relativeTime(at(10), now, true), '刚刚');
  assert.equal(relativeTime(at(300), now, true), '5 分钟');
  assert.equal(relativeTime(at(3 * 3600), now, true), '3 小时');
  assert.equal(relativeTime(at(2 * 86400), now, true), '2 天');
  assert.equal(relativeTime(at(10), now, false), 'now');
  assert.equal(relativeTime(at(300), now, false), '5 min');
  assert.equal(relativeTime(at(3 * 3600), now, false), '3 h');
  assert.equal(relativeTime(at(2 * 86400), now, false), '2 d');
});

test('R1: fold state is one bounded key, tolerant of bad JSON, with open projects/branches/parents and closed folds', () => {
  assert.equal(CATALOG_FOLD_KEY, 'threadterm.catalogFolds');
  assert.equal(foldExpanded({}, 'project', 'p1'), true);
  assert.equal(foldExpanded({}, 'branch', 'D:/a'), true);
  assert.equal(foldExpanded({}, 'parent', 's1'), true);
  assert.equal(foldExpanded({}, 'older', 'D:/a'), false);
  assert.equal(foldExpanded({}, 'other', 'p1'), false);
  assert.deepEqual(readCatalogFolds('not json'), {});
  assert.deepEqual(readCatalogFolds('[1,2]'), {});
  assert.deepEqual(readCatalogFolds('{"project:p1":false,"older:D:/a":true,"bad":false,"project:p2":"no"}'), { 'project:p1': false, 'older:D:/a': true });
  const closed = setCatalogFold({}, 'project', 'p1', false);
  assert.deepEqual(closed, { [foldKey('project', 'p1')]: false });
  assert.deepEqual(setCatalogFold(closed, 'project', 'p1', true), {});
  const parsed = readCatalogFolds(writeCatalogFolds(closed));
  assert.equal(foldExpanded(parsed, 'project', 'p1'), false);
  const many = Object.fromEntries(Array.from({ length: 450 }, (_, index) => [foldKey('branch', `b${index}`), index % 2 === 0]));
  assert.equal(Object.keys(boundedCatalogFolds(many)).length, 300);
  assert.deepEqual(readCatalogFolds(JSON.stringify(many))['branch:b449'], false);
});

test('fold keys and the remembered Projects/Recent choice', () => {
  assert.equal(foldKey('branch', 'D:/a'), 'branch:D:/a');
  assert.equal(readCatalogView('recent'), 'recent');
  assert.equal(readCatalogView('nonsense'), 'tree');
  assert.equal(readCatalogView(null), 'tree');
  assert.equal(writeCatalogView('recent'), 'recent');
  assert.equal(CATALOG_VIEW_KEY, 'threadterm.catalogView');
});
