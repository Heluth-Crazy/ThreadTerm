import type { ChatItem, ChatPlanEntry, Session } from '@threadterm/protocol';
import { delegationQuiet, delegationQuietLabel, quietMinutesText } from './delegation';
import { latestPlan, planProgress } from './chatPlan';

export type Copy = (en: string, zh: string) => string;

/** The card is 280 px wide; the message column is at most 920 px. */
export const OVERVIEW_CARD_WIDTH = 280;
export const OVERVIEW_COLUMN_WIDTH = 920;
/** Room for the card, its right margin and the gap to the message column. */
const OVERVIEW_GUTTER_MARGIN = 42;
export const OVERVIEW_FINISHED_OPEN_KEY = 'threadterm.chatOverview.finishedOpen.v1';
export const OVERVIEW_COLLAPSED_KEY = 'threadterm.chatOverview.collapsed.v1';
export const OVERVIEW_MAX_PARENTS = 200;

/** Docked only when the empty gutter right of the 920 px column fits the card. */
export function overviewDocked(chatWidth: number): boolean {
  if (!Number.isFinite(chatWidth) || chatWidth <= 0) return false;
  return (chatWidth - OVERVIEW_COLUMN_WIDTH) / 2 >= OVERVIEW_CARD_WIDTH + OVERVIEW_GUTTER_MARGIN;
}

export type OverviewDelegateGroups = {
  needs: Session[];
  quiet: Session[];
  failedStop: Session[];
  running: Session[];
  starting: Session[];
  finished: Session[];
  /** Delegates shown above the fold, in the agreed order. */
  active: Session[];
  /** Needs you + quiet, the number on the header button. */
  badge: number;
  failedFinished: number;
};

/**
 * Seconds of silence the runtime reported, or `undefined` when it did not: the
 * renderer shows quiet only when the runtime says so (R8).
 */
export function delegateQuietSeconds(delegate: Session, now = Date.now()): number | undefined {
  const quiet = delegationQuiet(delegate);
  if (!quiet) return undefined;
  return Math.max(0, Math.floor((now - Date.parse(quiet.since)) / 1000));
}

const finishedStates = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Agreed order: needs you, quiet, failed-to-stop, running, starting, then finished. */
export function overviewDelegateGroups(delegates: readonly Session[], now = Date.now()): OverviewDelegateGroups {
  const groups: OverviewDelegateGroups = {
    needs: [], quiet: [], failedStop: [], running: [], starting: [], finished: [],
    active: [], badge: 0, failedFinished: 0,
  };
  const ordered = [...delegates].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const delegate of ordered) {
    const state = delegate.delegation?.state;
    if (!state) continue;
    if (state === 'awaiting_user') groups.needs.push(delegate);
    else if (state === 'running' || state === 'starting') {
      if (delegateQuietSeconds(delegate, now) !== undefined) groups.quiet.push(delegate);
      else if (state === 'running') groups.running.push(delegate);
      else groups.starting.push(delegate);
    }
    else if (state === 'cancel_failed') groups.failedStop.push(delegate);
    else if (state === 'awaiting_parent' || state === 'cancelling') groups.running.push(delegate);
    else if (finishedStates.has(state)) groups.finished.push(delegate);
  }
  groups.active = [...groups.needs, ...groups.quiet, ...groups.failedStop, ...groups.running, ...groups.starting];
  groups.badge = groups.needs.length + groups.quiet.length;
  groups.failedFinished = groups.finished.filter(delegate => delegate.delegation?.state === 'failed').length;
  return groups;
}

export type OverviewTone = 'need' | 'quiet' | 'fail' | 'run' | 'done';

function durationText(seconds: number, copy: Copy): string {
  return quietMinutesText(seconds, copy);
}

function elapsedSeconds(delegate: Session, now: number): number | undefined {
  const started = Date.parse(delegate.createdAt);
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : undefined;
}

/** One row's state words; quiet replaces "Running · elapsed" when the runtime reports it. */
export function overviewStateText(delegate: Session, copy: Copy, now = Date.now()): { text: string; tone: OverviewTone; quietSince?: string } {
  const state = delegate.delegation?.state;
  if (state === 'awaiting_user') return { text: copy('Needs you', '待你处理'), tone: 'need' };
  if (state === 'running' || state === 'starting') {
    // R6: the row shows the runtime's quiet episode, and the minutes tick in
    // `QuietMinutes` from `quietSince` (the card never re-renders the transcript).
    const quiet = delegationQuiet(delegate);
    if (quiet) return { text: delegationQuietLabel(quiet.since, copy, now), tone: 'quiet', quietSince: quiet.since };
  }
  if (state === 'running') {
    const elapsed = elapsedSeconds(delegate, now);
    return { text: elapsed === undefined ? copy('Running', '执行中') : copy(`Running · ${durationText(elapsed, copy)}`, `执行中 · ${durationText(elapsed, copy)}`), tone: 'run' };
  }
  if (state === 'cancel_failed') return { text: copy('Stop failed', '停止失败'), tone: 'fail' };
  if (state === 'cancelling') return { text: copy('Stopping', '停止中'), tone: 'run' };
  if (state === 'awaiting_parent') return { text: copy('Waiting for parent agent', '等待委派方'), tone: 'run' };
  if (state === 'starting') return { text: copy('Starting', '启动中'), tone: 'run' };
  if (state === 'failed') return { text: copy('Failed', '失败'), tone: 'fail' };
  if (state === 'completed') return { text: copy('Completed', '已完成'), tone: 'done' };
  if (state === 'cancelled') return { text: copy('Cancelled', '已取消'), tone: 'done' };
  if (state === 'interrupted') return { text: copy('Interrupted', '已中断'), tone: 'done' };
  return { text: copy('Finished', '已结束'), tone: 'done' };
}

export function overviewFinishedLabel(count: number, failed: number, copy: Copy): { label: string; failed?: string } {
  return {
    label: copy(`${count} finished`, `${count} 个已结束`),
    ...(failed ? { failed: copy(`${failed} failed`, `${failed} 个失败`) } : {}),
  };
}

export type OverviewPlanSummary = {
  entries: readonly ChatPlanEntry[];
  explanation?: string;
  done: number;
  total: number;
  percent: number;
  current?: string;
  live: boolean;
  turnId?: string;
};

/** The newest plan, summarized for the card; no plan means no section. */
export function overviewPlan(items: readonly ChatItem[]): OverviewPlanSummary | undefined {
  const plan = latestPlan(items);
  if (!plan) return undefined;
  const entries = plan.data.entries;
  const { done, total } = planProgress(entries);
  const current = entries.find(entry => entry.status === 'in_progress') ?? entries.find(entry => entry.status === 'pending');
  return {
    entries, ...(plan.data.explanation ? { explanation: plan.data.explanation } : {}),
    done, total, percent: total ? Math.round((done / total) * 100) : 0,
    ...(current ? { current: current.content } : {}), live: plan.live, ...(plan.turnId ? { turnId: plan.turnId } : {}),
  };
}

export function overviewPlanText(plan: Pick<OverviewPlanSummary, 'done' | 'total' | 'current'>, copy: Copy): string {
  return `${plan.done}/${plan.total}${plan.current ? copy(` · Now: ${plan.current}`, ` · 当前：${plan.current}`) : ''}`;
}

/** The newest turn's review file count; no request, no +/− totals. */
export function overviewChangesFileCount(items: readonly ChatItem[]): number | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const review = items[index]!.turnReview;
    if (review && review.fileCount > 0) return review.fileCount;
  }
  return undefined;
}

export function overviewChangesLabel(count: number, copy: Copy): string {
  return copy(`${count} ${count === 1 ? 'file' : 'files'}`, `${count} 个文件`);
}

export function overviewHasSections(input: { delegates: readonly Session[]; plan?: unknown; changes?: number }): boolean {
  return input.delegates.length > 0 || Boolean(input.plan) || (input.changes ?? 0) > 0;
}

/** A single capped preference list, like the sidebar's expanded-delegate list. */
export function boundedOverviewParents(ids: readonly string[]): string[] {
  return [...new Set(ids)].slice(-OVERVIEW_MAX_PARENTS);
}

export function readOverviewFinishedOpen(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? boundedOverviewParents(parsed.filter((id): id is string => typeof id === 'string')) : [];
  } catch { return []; }
}

export function toggleOverviewFinishedOpen(ids: readonly string[], parentId: string, open: boolean): string[] {
  const next = new Set(ids);
  if (open) next.add(parentId); else next.delete(parentId);
  return boundedOverviewParents([...next]);
}

export function readOverviewCollapsed(raw: string | null): boolean {
  return raw === '1';
}
