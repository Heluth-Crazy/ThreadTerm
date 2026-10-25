import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWireSuccess } from '../protocol/generated-validators.js';
import { approvalData } from '../renderer/src/chatApproval';
import { contextSerializedBlocks, parseContext, serializeContext } from '../renderer/src/chatContext';
import { subagentInfo } from '../renderer/src/subagentActivity';
import { requiredSurfaceContext, requiredSurfaceItems, requiredSurfaceQueue, requiredSurfaceSession } from './fixtures/chat-visual-required-data';

test('required Chat visual fixture uses renderable contract shapes', () => {
  const approval = requiredSurfaceItems.find(item => item.id === 'approval')!.parts[0]!;
  const question = requiredSurfaceItems.find(item => item.id === 'question')!.parts[0]!;
  const usage = requiredSurfaceItems.find(item => item.id === 'usage')!.parts[0]!;
  const subagent = requiredSurfaceItems.find(item => item.id === 'subagent')!.parts[0]!;
  assert.equal(approvalData(approval)?.choices.length, 2);
  assert.equal((question.data as { interaction?: string }).interaction, 'question');
  assert.equal((question.data as { form?: { kind?: string; questions?: unknown[] } }).form?.kind, 'questions');
  assert.ok((question.data as { form?: { questions?: unknown[] } }).form?.questions?.length);
  assert.ok((usage.data as { rows?: unknown[] }).rows?.length);
  assert.equal(subagentInfo(subagent)?.key, 'required-surfaces-child');
  const serialized = serializeContext(requiredSurfaceContext, 'fixture message');
  assert.equal(contextSerializedBlocks(requiredSurfaceContext).length, 1);
  assert.equal(parseContext(serialized)?.items.length, 1);
  assert.equal(requiredSurfaceQueue.sessionId, requiredSurfaceSession.id);
  assert.ok(validateWireSuccess({ v: 1, id: 'fixture', method: 'chat.snapshot', result: { items: requiredSurfaceItems, revision: 1, hasEarlier: false, repair: { offered: true, mode: 'rebuild', degraded: true, diagnostic: 'Fixture projection gap.' } } }), JSON.stringify(validateWireSuccess.errors));
  assert.ok(validateWireSuccess({ v: 1, id: 'fixture', method: 'chat.queue.read', result: requiredSurfaceQueue }));
});
