import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatItem, ChatPart, ChatPlanData } from '@threadterm/protocol';
import { latestPlan, planDataOf, planEntryLabel, planProgress } from './chatPlan';

const copy = (en: string) => en;
const planPart = (entries: unknown, explanation?: string): ChatPart => ({
  type: 'plan', toolId: 'plan:t', status: 'complete', data: { entries, ...(explanation ? { explanation } : {}) },
} as ChatPart);
const item = (id: string, parts: ChatPart[], extra: Partial<ChatItem> = {}): ChatItem => ({
  id, role: 'assistant', parts, createdAt: '2026-10-12T00:00:00Z', turnId: 't', ...extra,
});

test('the plan part is part of the additive protocol contract', () => {
  const data: ChatPlanData = { entries: [{ content: 'One', status: 'pending', priority: 'low' }], explanation: 'why' };
  const part: ChatPart = { type: 'plan', toolId: 'plan:t', status: 'complete', data };
  assert.equal(planDataOf(part)?.entries.length, 1);
});

test('planDataOf normalizes entries and drops malformed data', () => {
  const data = planDataOf(planPart([
    { content: 'One', status: 'completed', priority: 'high' },
    { content: 'Two', status: 'nonsense', priority: 'urgent' },
    { content: '', status: 'pending' },
    'junk',
  ], 'why'));
  assert.equal(data?.entries.length, 2);
  assert.deepEqual(data?.entries[0], { content: 'One', status: 'completed', priority: 'high' });
  assert.deepEqual(data?.entries[1], { content: 'Two', status: 'pending' });
  assert.equal(data?.explanation, 'why');
  assert.equal(planDataOf({ type: 'plan', data: {} } as ChatPart), undefined);
  assert.equal(planDataOf({ type: 'text', text: 'x' } as ChatPart), undefined);
  assert.equal(planDataOf(undefined), undefined);
});

test('latestPlan picks the newest plan part and marks its origin', () => {
  const older = item('a', [planPart([{ content: 'Old', status: 'pending' }])], { turnOrigin: 'history' });
  const newer = item('b', [planPart([{ content: 'New', status: 'in_progress' }])]);
  const state = latestPlan([older, newer]);
  assert.equal(state?.itemId, 'b');
  assert.equal(state?.data.entries[0]?.content, 'New');
  assert.equal(state?.live, true);
  assert.equal(latestPlan([older])?.live, false);
  assert.equal(latestPlan([]), undefined);
  assert.equal(latestPlan([item('c', [{ type: 'text', text: 'hi' } as ChatPart])]), undefined);
});

test('planProgress and labels read the normalized entries', () => {
  const data = planDataOf(planPart([
    { content: 'One', status: 'completed' },
    { content: 'Two', status: 'in_progress', priority: 'medium' },
    { content: 'Three', status: 'pending' },
  ]))!;
  assert.deepEqual(planProgress(data.entries), { done: 1, total: 3 });
  assert.equal(planEntryLabel(data.entries[1]!, copy), 'In progress · Medium: Two');
  assert.equal(planEntryLabel(data.entries[2]!, copy), 'Pending: Three');
});
