import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatItem } from '@threadterm/protocol';
import { groupCodexTranscript } from './codexTranscript';
import { liveSpeedGroupIndex, liveTurnSpeed, nextLiveTurnUsage, turnSpeed, turnSpeedText, turnSpeedTooltip } from './turnSpeed';

test('turn speed rounds saved or live output and retains the estimate marker', () => {
  const exact = turnSpeed({ outputTokens: 52, generationMs: 1_040, firstTokenMs: 1_400 });
  assert.deepEqual(exact, { tokensPerSecond: 50, estimated: false, firstTokenMs: 1_400 });
  assert.equal(turnSpeedText(exact!), '50 tok/s');
  assert.equal(turnSpeedTooltip(exact!, false), 'Output tokens per second while the model was generating (tool runs and waits excluded). First token after 1.4 s.');
  const estimated = turnSpeed({ outputTokens: 52, generationMs: 1_000, outputTokensEstimated: true });
  assert.equal(turnSpeedText(estimated!), '≈ 52 tok/s');
  assert.match(turnSpeedTooltip(estimated!, true), /估算/);
});

test('turn speed hides unavailable and immaterial measurements', () => {
  assert.equal(turnSpeed(undefined), undefined);
  assert.equal(turnSpeed({ outputTokens: 0, generationMs: 1_000 }), undefined);
  assert.equal(turnSpeed({ outputTokens: 1, generationMs: 249 }), undefined);
  assert.equal(turnSpeed({ outputTokens: 1, generationMs: Number.NaN }), undefined);
});

test('live speed only renders for its active turn', () => {
  const live = { turnId: 'turn-1', usage: { outputTokens: 24, generationMs: 1_000 } };
  assert.equal(liveTurnSpeed(undefined, live), undefined);
  assert.equal(liveTurnSpeed('turn-2', live), undefined);
  assert.deepEqual(liveTurnSpeed('turn-1', live), { tokensPerSecond: 24, estimated: false });
});

test('active tool and wait events clear the prior live rate', () => {
  const current = { turnId: 'turn-1', usage: { outputTokens: 24, generationMs: 1_000 } };
  assert.equal(nextLiveTurnUsage(current, { turnId: 'turn-1', active: true }), undefined);
  assert.equal(nextLiveTurnUsage(current, { turnId: 'turn-1', active: false }), undefined);
  assert.equal(nextLiveTurnUsage(current, { turnId: 'turn-2', active: false }), current);
});

test('live speed renders once for a turn with a separate user group and two model calls', () => {
  const row = (id: string, role: ChatItem['role'], type: 'text' | 'tool'): ChatItem => ({
    id, role, turnId: 'live-turn', createdAt: 'now', parts: [{ type, text: id, status: 'streaming' }],
  });
  const groups = groupCodexTranscript([
    row('prompt', 'user', 'text'), row('first-call', 'assistant', 'text'),
    row('tool', 'tool', 'tool'), row('second-call', 'assistant', 'text'),
  ]);
  assert.equal(groups.length, 2, 'the user and assistant groups both belong to the live turn');
  const placement = liveSpeedGroupIndex(groups, 'live-turn');
  assert.equal(placement, 1);
  assert.equal(groups.filter((_, index) => index === placement).length, 1);
});

test('live speed selects only the last matching turn group, not another active group', () => {
  const row = (id: string, turnId: string, settled = false): ChatItem => ({
    id, role: 'assistant', turnId, createdAt: 'now', parts: [], ...(settled ? { turnStatus: 'completed' } : {}),
  });
  const groups = groupCodexTranscript([
    row('first', 'live-turn'), { id: 'boundary', role: 'system', createdAt: 'now', parts: [] },
    row('last', 'live-turn'), row('other-active', 'other-turn'),
  ]);
  assert.equal(liveSpeedGroupIndex(groups, 'live-turn'), 2);
  assert.equal(liveSpeedGroupIndex(groups, 'other-turn'), 3);
  assert.equal(liveSpeedGroupIndex(groups, 'missing-turn'), -1);
  assert.equal(liveSpeedGroupIndex(groups, undefined), -1);
  groups[2]!.settled = true;
  assert.equal(liveSpeedGroupIndex(groups, 'live-turn'), -1, 'a settled last group must not revive an earlier group');
  assert.equal(liveSpeedGroupIndex([], 'live-turn'), -1);
});
