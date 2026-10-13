import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatPart } from '@threadterm/protocol';
import { approvalData, planApprovalEnabled } from './chatApproval';

const card = (status = 'pending', extra = {}): ChatPart => ({
  type: 'approval', approvalId: 'plan:turn', status,
  data: { approvalId: 'plan:turn', interaction: 'plan', plan: '# Plan\n\n1. Add tests', submittable: true, choices: [], ...extra },
});

test('native and runtime-owned plan payloads preserve Markdown and empty plans', () => {
  assert.equal(approvalData(card())?.plan, '# Plan\n\n1. Add tests');
  assert.equal(approvalData(card('pending', { plan: '', runtimeOwned: true }))?.plan, '');
  assert.equal(approvalData(card('pending', { runtimeOwned: true }))?.runtimeOwned, true);
  assert.equal(planApprovalEnabled(card(), true), true);
});

test('plan decisions cannot grant from inactive, readonly, submitting or waiting cards', () => {
  for (const status of ['resolved', 'answered', 'expired', 'failed', 'dismissed', 'outcomeUnknown']) assert.equal(planApprovalEnabled(card(status), true), false);
  assert.equal(planApprovalEnabled(card(), false), false);
  assert.equal(planApprovalEnabled(card(), true, 'approve'), false);
  assert.equal(planApprovalEnabled(card('pending', { waitingForPrompt: true }), true), false);
  assert.equal(planApprovalEnabled(card('pending', { submittable: false }), true), false);
});

test('plan decisions reload as records with their user feedback', () => {
  for (const outcome of ['approved', 'changes_requested', 'abandoned']) {
    const part = JSON.parse(JSON.stringify(card('answered', { planOutcome: outcome, feedback: 'Include tests' })));
    assert.equal(approvalData(part)?.planOutcome, outcome);
    assert.equal(approvalData(part)?.feedback, 'Include tests');
    assert.equal(planApprovalEnabled(part, true), false);
  }
});
