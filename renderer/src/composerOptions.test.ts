import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatSessionOption } from '@threadterm/protocol';
import {
  booleanText,
  chipValueText,
  choiceText,
  currentChoiceName,
  filterModelChoices,
  foldExtraChips,
  groupChoices,
  isBooleanOption,
  isRecommended,
  modelRows,
  optionCategory,
  optionTitle,
  partitionOptions,
  thinkingChipText,
  virtualWindow,
} from './composerOptions';

const copy = (en: string) => en;
const option = (partial: Partial<ChatSessionOption> & Pick<ChatSessionOption, 'id' | 'value'>): ChatSessionOption => ({
  name: partial.id,
  choices: [],
  ...partial,
});

test('permission recovery exposes readable bilingual reset choices and staged state', () => {
  const reset = option({ id: 'threadterm-permission-recovery', category: 'mode', value: 'unavailable' });
  assert.equal(chipValueText(reset, false), 'Reset permissions…');
  assert.equal(chipValueText(reset, true), '重置权限…');
  assert.equal(chipValueText({ ...reset, value: 'defaults' }, false), 'Use defaults');
  assert.equal(chipValueText({ ...reset, value: 'defaults' }, true), '使用默认权限');
  assert.equal(choiceText(reset, { value: 'defaults', name: '' }, false), 'Discard saved permissions and use provider defaults');
  assert.equal(choiceText(reset, { value: 'defaults', name: '' }, true), '丢弃已保存的权限并使用提供方默认权限');
});

test('optionCategory prefers the runtime metadata and falls back to the legacy regex', () => {
  assert.equal(optionCategory(option({ id: 'model', value: 'm', category: 'other' })), 'other');
  assert.equal(optionCategory(option({ id: 'model', value: 'm' })), 'model');
  assert.equal(optionCategory(option({ id: 'x', name: 'Thinking level', value: 'high' })), 'thinking');
  assert.equal(optionCategory(option({ id: 'reasoning_effort', value: 'low' })), 'thinking');
  assert.equal(optionCategory(option({ id: 'approval-mode', value: 'never' })), 'mode');
  assert.equal(optionCategory(option({ id: 'fast', value: 'true' })), 'other');
});

test('isBooleanOption reads the kind contract and tolerates legacy On/Off rows', () => {
  assert.equal(isBooleanOption(option({ id: 'fast', value: 'true', kind: 'boolean' })), true);
  assert.equal(isBooleanOption(option({ id: 'fast', value: 'off', choices: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] })), true);
  assert.equal(isBooleanOption(option({ id: 'reviewer', value: 'user', choices: [{ value: 'user', name: 'User' }, { value: 'auto_review', name: 'Auto review' }, { value: 'guardian_subagent', name: 'Guardian subagent' }] })), false);
});

test('labels localize known provider values and keep unknown ones', () => {
  const mode = option({ id: 'mode', value: 'on-request', choices: [{ value: 'on-request', name: 'Ask as needed' }, { value: 'never', name: 'Never ask' }] });
  assert.equal(chipValueText(mode, false), 'Ask as needed');
  assert.equal(chipValueText(mode, true), '按需询问');
  assert.equal(choiceText(mode, { value: 'never', name: 'Never ask' }, true), '从不询问');
  const reviewer = option({ id: 'reviewer', value: 'auto_review', choices: [{ value: 'auto_review', name: 'Auto review' }] });
  assert.equal(chipValueText(reviewer, true), '自动审查');
  const custom = option({ id: 'acp-extra', value: 'x', name: 'ACP extra', choices: [{ value: 'x', name: 'Custom value' }] });
  assert.equal(chipValueText(custom, true), 'Custom value');
  assert.equal(currentChoiceName(custom), 'Custom value');
});

test('titles and boolean text are bilingual', () => {
  assert.equal(optionTitle(option({ id: 'fast', value: 'true' }), (en, zh) => zh), '快速模式');
  assert.equal(optionTitle(option({ id: 'reviewer', value: 'user' }), (en) => en), 'Approval reviewer');
  assert.equal(optionTitle(option({ id: 'acp-extra', value: 'x', name: 'ACP extra' }), copy), 'ACP extra');
  assert.equal(booleanText('true', copy), 'On');
  assert.equal(booleanText('off', copy), 'Off');
  assert.equal(thinkingChipText(option({ id: 'thinking', value: 'high', choices: [{ value: 'high', name: 'Thinking high' }] }), false), 'High');
});

test('partitionOptions matches the legacy grouping and keeps extra order', () => {
  const options = [
    option({ id: 'model', value: 'm', choices: [{ value: 'm', name: 'M' }] }),
    option({ id: 'thinking', value: 'high', choices: [{ value: 'high', name: 'High' }] }),
    option({ id: 'collaboration', value: 'default', choices: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] }),
    option({ id: 'mode', value: 'never', choices: [{ value: 'never', name: 'Never ask' }] }),
    option({ id: 'sandbox', value: 'read-only', choices: [{ value: 'read-only', name: 'Read only' }] }),
    option({ id: 'fast', value: 'true', kind: 'boolean', choices: [{ value: 'true', name: 'On' }, { value: 'false', name: 'Off' }] }),
    option({ id: 'reviewer', value: 'user', choices: [{ value: 'user', name: 'User' }] }),
    option({ id: 'empty-extra', value: 'x' }),
  ];
  const groups = partitionOptions(options);
  assert.equal(groups.model?.id, 'model');
  assert.equal(groups.thinking?.id, 'thinking');
  assert.equal(groups.mode?.id, 'mode');
  assert.deepEqual(groups.extras.map(extra => extra.id), ['collaboration', 'sandbox', 'fast', 'reviewer']);
});

test('foldExtraChips keeps the largest visible prefix and reserves the cog', () => {
  const widths = [90, 100, 80];
  assert.deepEqual(foldExtraChips({ available: 500, gap: 6, widths, cogWidth: 26 }), { visibleCount: 3, foldedCount: 0 });
  assert.deepEqual(foldExtraChips({ available: 200, gap: 6, widths, cogWidth: 26 }), { visibleCount: 1, foldedCount: 2 });
  assert.deepEqual(foldExtraChips({ available: 120, gap: 6, widths, cogWidth: 26 }), { visibleCount: 0, foldedCount: 3 });
  assert.deepEqual(foldExtraChips({ available: 0, gap: 6, widths, cogWidth: 26 }), { visibleCount: 0, foldedCount: 3 });
  assert.deepEqual(foldExtraChips({ available: 500, gap: 6, widths: [], cogWidth: 26 }), { visibleCount: 0, foldedCount: 0 });
});

test('filterModelChoices matches name and value and groupChoices keeps order', () => {
  const choices = [
    { value: 'openai/gpt-5', name: 'GPT-5', group: 'openai' },
    { value: 'anthropic/claude', name: 'Claude', group: 'anthropic' },
    { value: 'openai/gpt-4', name: 'GPT-4', group: 'openai' },
  ];
  assert.equal(filterModelChoices(choices, '').length, 3);
  assert.deepEqual(filterModelChoices(choices, 'gpt').map(choice => choice.value), ['openai/gpt-5', 'openai/gpt-4']);
  assert.deepEqual(filterModelChoices(choices, 'CLAUDE').map(choice => choice.value), ['anthropic/claude']);
  assert.deepEqual(groupChoices(choices).map(group => [group.key, group.choices.length]), [['openai', 2], ['anthropic', 1]]);
});

test('modelRows inserts headers only when choices are grouped and supports search', () => {
  const grouped = [
    { value: 'openai/gpt-5', name: 'GPT-5', group: 'openai' },
    { value: 'anthropic/claude', name: 'Claude', group: 'anthropic' },
  ];
  assert.deepEqual(modelRows(grouped, '').map(row => (row.kind === 'header' ? `#${row.key}` : row.choice.value)), ['#openai', 'openai/gpt-5', '#anthropic', 'anthropic/claude']);
  const flat = [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }];
  assert.deepEqual(modelRows(flat, '').map(row => (row.kind === 'header' ? `#${row.key}` : row.choice.value)), ['a', 'b']);
  assert.equal(modelRows(grouped, 'nothing').length, 0);
  assert.equal(isRecommended(option({ id: 'model', value: 'a', recommended: 'a' }), { value: 'a', name: 'A' }), true);
  assert.equal(isRecommended(option({ id: 'model', value: 'a' }), { value: 'a', name: 'A', recommended: true }), true);
  assert.equal(isRecommended(option({ id: 'model', value: 'a' }), { value: 'a', name: 'A' }), false);
});

test('virtualWindow clamps both bounds and keeps a nonempty terminal window', () => {
  assert.deepEqual(virtualWindow({ count: 200, scrollTop: 0, rowHeight: 30, viewportHeight: 240 }), { start: 0, end: 16 });
  assert.deepEqual(virtualWindow({ count: 200, scrollTop: 300, rowHeight: 30, viewportHeight: 240 }), { start: 6, end: 22 });
  assert.deepEqual(virtualWindow({ count: 5, scrollTop: 0, rowHeight: 30, viewportHeight: 240 }), { start: 0, end: 5 });
  assert.deepEqual(virtualWindow({ count: 0, scrollTop: 0, rowHeight: 30, viewportHeight: 240 }), { start: 0, end: 0 });
  assert.deepEqual(virtualWindow({ count: 200, scrollTop: -80, rowHeight: 30, viewportHeight: 240 }), { start: 0, end: 16 });
  // Past the last row used to return { start: 329, end: 200 } or { start: 200, end: 200 }, both empty slices.
  const last = virtualWindow({ count: 200, scrollTop: 10_000, rowHeight: 30, viewportHeight: 240 });
  assert.deepEqual(last, { start: 184, end: 200 });
  const exactEnd = virtualWindow({ count: 200, scrollTop: 30 * 200, rowHeight: 30, viewportHeight: 240 });
  assert.deepEqual(exactEnd, { start: 184, end: 200 });
  for (const scrollTop of [0, 1, 29, 30, 240, 999, 6000, 10_000]) {
    const window = virtualWindow({ count: 200, scrollTop, rowHeight: 30, viewportHeight: 240 });
    assert.ok(window.start >= 0 && window.end <= 200 && window.start < window.end, `scroll ${scrollTop} yielded ${window.start}..${window.end}`);
  }
});

test('extra high thinking uses readable bilingual chip and menu labels', () => {
  const thinking = option({ id: 'thinking', value: 'xhigh', choices: [{ value: 'xhigh', name: 'Xhigh' }] });
  assert.equal(thinkingChipText(thinking, false), 'Extra high');
  assert.equal(thinkingChipText(thinking, true), '超高');
  assert.equal(choiceText(thinking, thinking.choices[0], false), 'Extra high');
});
