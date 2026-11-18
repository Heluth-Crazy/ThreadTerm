import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem, ChatPlanEntry, Session, SessionDelegationState } from '@threadterm/protocol';
import {
  boundedOverviewParents, delegateQuietSeconds, overviewBranchHead, overviewBranchName, overviewChangeKindLabel,
  overviewChangeRowLabel, overviewChangesFileCount, overviewChangesLabel, overviewCompareStat,
  overviewDelegateGroups, overviewDocked, overviewFinishedLabel, overviewHasSections, overviewPlan,
  overviewPlanText, overviewReviewStat, overviewSessionCheckpoint, overviewStateText, overviewStatText,
  readOverviewCollapsed, readOverviewFinishedOpen, toggleOverviewFinishedOpen, OVERVIEW_MAX_PARENTS,
} from './chatOverview';

const now = Date.parse('2026-11-11T12:00:00Z');
const copy = (en: string) => en;

function delegate(id: string, state: SessionDelegationState, extra: Record<string, unknown> = {}): Session {
  return {
    id, title: id, provider: 'codex', mode: 'chat', status: 'running',
    createdAt: '2026-11-11T11:22:00Z', updatedAt: '2026-11-11T11:22:00Z',
    delegation: { id: `d-${id}`, parentSessionId: 'parent', workspace: 'shared', state, ...extra },
  };
}

const ids = (list: readonly Session[]) => list.map(session => session.id);

test('docking needs the 280 px card, its margin and the gap beside the 920 px column', () => {
  assert.equal(overviewDocked(1563), false);
  assert.equal(overviewDocked(1564), true);
  assert.equal(overviewDocked(1920), true);
  assert.equal(overviewDocked(0), false);
  assert.equal(overviewDocked(Number.NaN), false);
});

test('rows follow needs you, quiet, failed-to-stop, running, starting and fold the rest', () => {
  const delegates = [
    delegate('done', 'completed'), delegate('start', 'starting'), delegate('cancel', 'cancelling'),
    delegate('stopfail', 'cancel_failed', { lastActivityAt: '2026-11-11T11:45:00Z' }), delegate('quiet', 'running', { lastActivityAt: '2026-11-11T11:42:00Z' }),
    delegate('run', 'running'), delegate('wait', 'awaiting_parent'), delegate('need', 'awaiting_user'),
    delegate('failed', 'failed'), delegate('cancelled', 'cancelled'),
  ];
  const groups = overviewDelegateGroups(delegates, now);
  assert.deepEqual(ids(groups.active), ['need', 'quiet', 'stopfail', 'cancel', 'run', 'wait', 'start'], 'same-start delegates keep their input order inside a group');
  assert.deepEqual(ids(groups.finished), ['done', 'failed', 'cancelled']);
  assert.equal(groups.badge, 2, 'needs you plus quiet');
  assert.equal(groups.failedFinished, 1);
  assert.deepEqual(overviewFinishedLabel(3, 1, copy), { label: '3 finished', failed: '1 failed' });
  assert.deepEqual(overviewFinishedLabel(2, 0, copy), { label: '2 finished' });
});

test('a running delegate is quiet only when the runtime says so', () => {
  assert.equal(delegateQuietSeconds(delegate('run', 'running'), now), undefined);
  // No `lastActivityAt` means no quiet episode, however long the session has been up.
  assert.equal(delegateQuietSeconds(delegate('old', 'running', { updatedAt: '2026-11-11T09:00:00Z' }), now), undefined);
  assert.equal(delegateQuietSeconds(delegate('a', 'running', { lastActivityAt: '2026-11-11T11:42:00Z' }), now), 1080);
  assert.equal(delegateQuietSeconds(delegate('a', 'starting', { lastActivityAt: '2026-11-11T11:42:00Z' }), now), 1080);
  // The runtime reports quiet for live states only, and the renderer keeps that rule.
  for (const state of ['awaiting_user', 'awaiting_parent', 'cancelling', 'cancel_failed', 'completed', 'failed'] as const) {
    assert.equal(delegateQuietSeconds(delegate('q', state, { lastActivityAt: '2026-11-11T11:42:00Z' }), now), undefined, state);
  }
  const quiet = overviewStateText(delegate('q', 'running', { lastActivityAt: '2026-11-11T11:42:00Z' }), copy, now);
  assert.equal(quiet.text, 'No activity for 18 min');
  assert.equal(quiet.tone, 'quiet');
  assert.equal(quiet.quietSince, '2026-11-11T11:42:00Z', 'the row ticks its own minutes from this');
  assert.equal(overviewStateText(delegate('run', 'running'), copy, now).text, 'Running · 38 min');
  assert.equal(overviewStateText(delegate('need', 'awaiting_user'), copy, now).text, 'Needs you');
});

test('sections hide when empty and the card hides when all are', () => {
  assert.equal(overviewHasSections({ delegates: [] }), false);
  assert.equal(overviewHasSections({ delegates: [], changes: 0 }), false);
  assert.equal(overviewHasSections({ delegates: [], changes: 2 }), true);
  assert.equal(overviewHasSections({ delegates: [], plan: {} }), true);
  assert.equal(overviewHasSections({ delegates: [delegate('a', 'running')] }), true);
  assert.equal(overviewChangesLabel(1, copy), '1 file');
  assert.equal(overviewChangesLabel(7, copy), '7 files');
});

const planItem = (entries: ChatPlanEntry[], turnOrigin?: 'history'): ChatItem => ({
  id: 'plan', role: 'assistant', createdAt: '2026-11-11T11:30:00Z', parts: [{ type: 'plan', data: { entries } }],
  ...(turnOrigin ? { turnOrigin } : {}),
});

test('the plan section summarizes progress and the current step', () => {
  const plan = overviewPlan([planItem([
    { content: 'Map the projection', status: 'completed' },
    { content: 'Build the card', status: 'in_progress' },
    { content: 'Run the suite', status: 'pending' },
  ])]);
  assert.ok(plan);
  assert.equal(plan.done, 1);
  assert.equal(plan.total, 3);
  assert.equal(plan.percent, 33);
  assert.equal(plan.current, 'Build the card');
  assert.equal(overviewPlanText(plan, copy), '1/3 · Now: Build the card');
  assert.equal(overviewPlan([]), undefined);
  assert.equal(overviewPlan([planItem([])]), undefined, 'an unusable plan is not a section');
});

test('changes use the newest turn review count and never fetch', () => {
  const items: ChatItem[] = [
    { id: 'a', role: 'assistant', createdAt: '2026-11-11T11:00:00Z', parts: [], turnReview: { from: 'a', to: 'b', fileCount: 3 } },
    { id: 'b', role: 'assistant', createdAt: '2026-11-11T11:10:00Z', parts: [], turnReview: { from: 'b', to: 'c', fileCount: 7 } },
  ];
  assert.equal(overviewChangesFileCount(items), 7);
  assert.equal(overviewChangesFileCount([items[0]!]), 3);
  assert.equal(overviewChangesFileCount([]), undefined);
});

test('session changes start at the oldest ready checkpoint, ignoring failed ones', () => {
  const checkpoint = (id: string, status: 'ready' | 'failed') => ({
    id, sessionId: 's', kind: 'turn' as const, createdAt: '2026-11-11T11:00:00Z', status, skipped: [],
  });
  // `review.list` is newest first.
  const list = [checkpoint('new', 'ready'), checkpoint('failed', 'failed'), checkpoint('old', 'ready')];
  assert.equal(overviewSessionCheckpoint(list)?.id, 'old');
  assert.equal(overviewSessionCheckpoint([checkpoint('only', 'ready')])?.id, 'only');
  assert.equal(overviewSessionCheckpoint([checkpoint('failed', 'failed')]), undefined);
  assert.equal(overviewSessionCheckpoint([]), undefined);
});

test('both rows sum files and lines the way the panels do', () => {
  assert.deepEqual(overviewReviewStat([
    { path: 'a.ts', status: 'M', added: 200, removed: 29 },
    { path: 'b.bin', status: 'A', binary: true },
    { path: 'c.ts', status: 'D' },
  ]), { files: 3, added: 200, removed: 29 }, 'binary files count as files with no lines, missing counts are zero');
  assert.deepEqual(overviewReviewStat([]), { files: 0, added: 0, removed: 0 });
  assert.deepEqual(overviewCompareStat([
    { path: 'a.ts', status: 'modified', additions: 480, deletions: 70, binary: false },
    { path: 'b.bin', status: 'added', additions: 0, deletions: 0, binary: true },
  ]), { files: 2, added: 480, removed: 70 });
  assert.deepEqual(overviewCompareStat([]), { files: 0, added: 0, removed: 0 });
});

test('the stat and the row label read in both languages', () => {
  const zh = (_en: string, cn: string) => cn;
  const stat = { files: 7, added: 205, removed: 29 };
  assert.equal(overviewChangesLabel(1, copy), '1 file');
  assert.equal(overviewChangesLabel(7, zh), '7 个文件');
  assert.equal(overviewStatText(stat, copy), '7 files +205 −29');
  assert.equal(overviewStatText(stat, zh), '7 个文件 +205 −29');
  assert.equal(overviewStatText({ files: 1, added: 0, removed: 0 }, copy), '1 file +0 −0');
  assert.equal(overviewChangeKindLabel('session', copy), 'This session');
  assert.equal(overviewChangeKindLabel('branch', zh), '当前分支');
  assert.equal(overviewChangeRowLabel('session', stat, copy), 'This session: 7 files, 205 added, 29 removed');
  assert.equal(overviewChangeRowLabel('session', { files: 1, added: 2, removed: 0 }, copy), 'This session: 1 file, 2 added, 0 removed');
  assert.equal(overviewChangeRowLabel('branch', stat, zh), '当前分支：7 个文件，新增 205 行，删除 29 行');
});

test('the head names the branch and says when only the uncommitted work counts', () => {
  const zh = (_en: string, cn: string) => cn;
  assert.deepEqual(overviewBranchHead({ branch: 'feat/x', base: 'main' }, copy), {
    text: 'feat/x', title: 'feat/x compared with main, uncommitted changes included',
  });
  assert.deepEqual(overviewBranchHead({ branch: 'feat/x', base: 'main', committedOnly: true }, copy), {
    text: 'feat/x', title: 'feat/x compared with main, committed only',
  });
  assert.deepEqual(overviewBranchHead({ branch: 'main', base: 'main' }, copy), {
    text: 'main · uncommitted', title: 'main compared with main, uncommitted changes included',
  });
  assert.deepEqual(overviewBranchHead({ branch: 'main', base: 'main' }, zh), {
    text: 'main · 未提交', title: 'main 对比 main，含未提交的改动',
  });
  assert.deepEqual(overviewBranchHead({ branch: 'feat/x' }, copy), { text: 'feat/x', title: 'feat/x' });
  assert.equal(overviewBranchHead({ base: 'main' }, copy), undefined);
  assert.equal(overviewBranchName('feat/x', 'abcdef0123456'), 'feat/x');
  assert.equal(overviewBranchName(null, 'abcdef0123456'), 'abcdef0', 'a detached head is the short commit');
  assert.equal(overviewBranchName('', undefined), undefined);
});

test('finished folding is remembered per parent, capped and tolerant of bad storage', () => {
  const many = Array.from({ length: OVERVIEW_MAX_PARENTS + 20 }, (_, index) => `p${index}`);
  assert.deepEqual(boundedOverviewParents([...many, `p${OVERVIEW_MAX_PARENTS + 19}`]), many.slice(20));
  assert.deepEqual(readOverviewFinishedOpen('not json'), []);
  assert.deepEqual(readOverviewFinishedOpen('{"parent":true}'), []);
  assert.deepEqual(readOverviewFinishedOpen('["a",7,null,"a","b"]'), ['a', 'b']);
  assert.deepEqual(toggleOverviewFinishedOpen(['a', 'b'], 'a', false), ['b']);
  assert.deepEqual(toggleOverviewFinishedOpen(['a'], 'b', true), ['a', 'b']);
  assert.deepEqual(toggleOverviewFinishedOpen([], 'b', false), []);
  assert.equal(readOverviewCollapsed('1'), true);
  assert.equal(readOverviewCollapsed('0'), false);
  assert.equal(readOverviewCollapsed(null), false);
});
