import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem } from '@threadterm/protocol';
import { AUTOMATIC_FIRST_LINE, automaticSummary, automaticText, automaticUpdateLabel, automaticUpdates, isAutomaticItem, isAutomaticText } from './automaticUpdate';

const copy = (en: string, _zh: string) => en;
const zhCopy = (_en: string, zh: string) => zh;

const closing = 'Handle these, then end your turn. ThreadTerm wakes you again on the next update. Use ask_user only for decisions that belong to the user.';
const message = [
  AUTOMATIC_FIRST_LINE,
  '- "Fix the parser" (codex, d-1) completed. Read it with delegate_result.',
  '- "Fix the parser" (codex, d-2) failed: exit 1 at step two',
  '- "Fix the parser" (codex, d-3) was interrupted before it finished. Read what it did with delegate_result.',
  '- "Fix the parser" (codex, d-4) could not be stopped: the stop was refused. Check it with delegate_status; it may still be working.',
  '- "Fix the parser" (claude, d-5) asks: "Which approach?". Answer with delegate_respond (requestId r-1; choices in delegate_status).',
  '- "Fix the parser" (pi, d-6) has had no activity for 12 min. Check it with delegate_status; stop it with delegate_cancel if it is stuck.',
  '- "Fix the parser" (pi, d-7) has had no activity for 5 min, while running rg. Check it with delegate_status; stop it with delegate_cancel if it is stuck.',
  closing,
].join('\n');

test('the fixed first line and the closing line are never updates', () => {
  const updates = automaticUpdates(message);
  assert.equal(updates.length, 7);
  assert.deepEqual(updates.map(update => update.kind), ['completed', 'failed', 'interrupted', 'cancel_failed', 'request', 'quiet', 'quiet']);
  assert.ok(!updates.some(update => JSON.stringify(update).includes('Handle these')), 'the closing line stays model-facing');
});

test('each update keeps the title, agent and its own detail', () => {
  const updates = automaticUpdates(message);
  assert.deepEqual(updates[0], { kind: 'completed', title: 'Fix the parser', agent: 'codex' });
  assert.deepEqual(updates[1], { kind: 'failed', title: 'Fix the parser', agent: 'codex', error: 'exit 1 at step two' });
  assert.deepEqual(updates[3], { kind: 'cancel_failed', title: 'Fix the parser', agent: 'codex', error: 'the stop was refused' });
  assert.deepEqual(updates[4], { kind: 'request', title: 'Fix the parser', agent: 'claude', request: 'Which approach?' });
  assert.deepEqual(updates[5], { kind: 'quiet', title: 'Fix the parser', agent: 'pi', minutes: 12 });
  assert.equal(updates[6]!.kind === 'quiet' && updates[6].tool, 'rg');
});

test('updates read in the user\'s language and never show the model-facing text', () => {
  const updates = automaticUpdates(message);
  assert.equal(automaticUpdateLabel(updates[0]!, copy), '"Fix the parser" finished');
  assert.equal(automaticUpdateLabel(updates[0]!, zhCopy), '「Fix the parser」已完成');
  assert.equal(automaticUpdateLabel(updates[1]!, zhCopy), '「Fix the parser」失败：exit 1 at step two');
  assert.equal(automaticUpdateLabel(updates[2]!, zhCopy), '「Fix the parser」被中断了');
  assert.equal(automaticUpdateLabel(updates[3]!, zhCopy), '「Fix the parser」没能停下');
  assert.equal(automaticUpdateLabel(updates[4]!, zhCopy), '「Fix the parser」在问：Which approach?');
  assert.equal(automaticUpdateLabel(updates[5]!, zhCopy), '「Fix the parser」12 分钟没有动静');
  for (const update of updates) {
    const label = automaticUpdateLabel(update, copy) + automaticUpdateLabel(update, zhCopy);
    assert.doesNotMatch(label, /delegate_|requestId|\(\w+, d-\d\)/, 'no tool names or delegation ids reach the user');
  }
});

test('a line of an unknown shape is shown as plain text without its bullet', () => {
  const updates = automaticUpdates([AUTOMATIC_FIRST_LINE, '- Something new happened', closing].join('\n'));
  assert.deepEqual(updates, [{ kind: 'text', text: 'Something new happened' }]);
  assert.equal(automaticUpdateLabel(updates[0]!, zhCopy), 'Something new happened');
});

test('a title with a quote and a comma still parses', () => {
  const updates = automaticUpdates([AUTOMATIC_FIRST_LINE, '- "Fix "the" parser, again" (codex, d-9) completed. Read it with delegate_result.'].join('\n'));
  assert.deepEqual(updates, [{ kind: 'completed', title: 'Fix "the" parser, again', agent: 'codex' }]);
});

test('the collapsed summary is the first update plus the rest of the count', () => {
  const summary = automaticSummary(message, zhCopy);
  assert.equal(summary.first, '「Fix the parser」已完成');
  assert.equal(summary.more, 6);
  assert.equal(automaticSummary('', copy).first, 'Delegate update');
});

const userItem = (parts: ChatItem['parts'], role: ChatItem['role'] = 'user'): ChatItem => ({ id: 'i', role, parts, createdAt: '2026-11-02T00:00:00Z' });

test('an item is automatic by its flag, never by its text', () => {
  assert.equal(isAutomaticItem(userItem([{ type: 'text', text: message, automatic: true }])), true);
  assert.equal(isAutomaticItem(userItem([{ type: 'text', text: message }])), false, 'a rebuilt history item without the flag is not trusted by text');
  assert.equal(isAutomaticItem(userItem([{ type: 'text', text: message, automatic: true }], 'assistant')), false);
  assert.equal(isAutomaticItem(undefined), false);
  assert.equal(isAutomaticText(message), true);
  assert.equal(isAutomaticText('hello'), false);
});

test('the automatic text of an item is its automatic text parts only', () => {
  const text = automaticText(userItem([{ type: 'text', text: 'notes' }, { type: 'text', text: message, automatic: true }]));
  assert.equal(text, message);
  assert.equal(automaticText(userItem([{ type: 'text', text: 'notes' }])), undefined);
});
