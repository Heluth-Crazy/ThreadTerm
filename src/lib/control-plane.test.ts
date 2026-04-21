import { describe, expect, it } from 'vitest';
import type { Task } from './tauri-bridge';
import {
  buildVisibleControlPlaneItems,
  RESULT_INBOX_ACCEPTED_NEXT_STEP,
  REVIEW_QUEUE_NEXT_STEP,
  REVIEW_REQUIRED_RESULT_RISK_SUMMARY,
  buildAcceptedReviewResultPatch,
  getTaskTimelineStage,
  getVisibleTaskControlPlaneSurface,
  getTaskControlPlaneSurface,
  hasStructuredTaskResultDetails,
  hasTaskResultPayload,
  isAcceptedResultTask,
} from './control-plane';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Review Mission Control semantics',
    description: 'Review Mission Control semantics',
    prompt: 'Review Mission Control semantics',
    status: 'done',
    provider: 'claude',
    execution_strategy: 'current_project',
    project_path: '/repo-a',
    created_at: '2026-04-21T08:00:00.000Z',
    updated_at: '2026-04-21T08:05:00.000Z',
    deps: [],
    review_required: false,
    ...overrides,
  };
}

describe('control-plane semantics helpers', () => {
  it('classifies approval, review, and accepted result surfaces consistently', () => {
    expect(getTaskControlPlaneSurface(makeTask({ status: 'pending_approval' }))).toBe('approval-inbox');
    expect(getTaskControlPlaneSurface(makeTask({ status: 'pending_review', review_required: true }))).toBe('review-queue');
    expect(
      getTaskControlPlaneSurface(
        makeTask({
          status: 'done',
          review_required: false,
          result_changed_files: ['src/components/overview/MissionControlView.tsx'],
        }),
      ),
    ).toBe('result-inbox');
  });

  it('classifies queued, running, review, and terminal outcomes into stable timeline stages', () => {
    expect(getTaskTimelineStage(makeTask({ status: 'queued' }))).toBe('backlog');
    expect(getTaskTimelineStage(makeTask({ status: 'pending_approval' }))).toBe('running');
    expect(getTaskTimelineStage(makeTask({ status: 'pending_review' }))).toBe('review');
    expect(getTaskTimelineStage(makeTask({ status: 'done' }))).toBe('completed');
    expect(getTaskTimelineStage(makeTask({ status: 'failed' }))).toBe('completed');
    expect(getTaskTimelineStage(makeTask({ status: 'cancelled' }))).toBe('completed');
    expect(getTaskTimelineStage(makeTask({ status: 'archived' }))).toBeNull();
  });

  it('gates control-plane surfaces by the items currently visible inside Mission Control', () => {
    expect(
      getVisibleTaskControlPlaneSurface(makeTask({
        id: 'task-approval',
        status: 'in_progress',
        session_id: 'session-approval',
      }), {
        pendingApprovalSessionIds: new Set(['session-approval']),
      }),
    ).toBe('approval-inbox');

    expect(
      getVisibleTaskControlPlaneSurface(makeTask({
        id: 'task-result',
        status: 'done',
        result_summary: 'Completed control-plane result.',
      }), {
        resultTaskIds: new Set(['task-other']),
      }),
    ).toBeNull();
  });

  it('keeps a focused off-list control-plane item visible without dropping the default recent slice', () => {
    expect(
      buildVisibleControlPlaneItems(
        [
          { id: 'item-1' },
          { id: 'item-2' },
          { id: 'item-3' },
          { id: 'item-4' },
        ],
        2,
        'item-4',
      ).map((item) => item.id),
    ).toEqual(['item-1', 'item-2', 'item-4']);
  });

  it('treats result summary as recoverable payload but keeps structured-detail checks narrower', () => {
    const summaryOnlyTask = makeTask({
      result_summary: 'Completed control-plane result.',
    });

    expect(hasTaskResultPayload(summaryOnlyTask)).toBe(true);
    expect(isAcceptedResultTask(summaryOnlyTask)).toBe(true);
    expect(hasStructuredTaskResultDetails(summaryOnlyTask)).toBe(false);
  });

  it('converts accepted reviews from review-queue guidance into result-inbox guidance', () => {
    expect(
      buildAcceptedReviewResultPatch(
        makeTask({
          status: 'pending_review',
          review_required: true,
          result_changed_files: ['src/hooks/useAutoExecutor.ts'],
          result_risk_summary: REVIEW_REQUIRED_RESULT_RISK_SUMMARY,
          result_suggested_next_step: REVIEW_QUEUE_NEXT_STEP,
        }),
      ),
    ).toEqual({
      result_risk_summary: '',
      result_suggested_next_step: RESULT_INBOX_ACCEPTED_NEXT_STEP,
    });
  });
});
