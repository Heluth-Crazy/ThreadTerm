// Unit tests for the shared visual-consistency helper (issue VC, step V1).
// Run with the QA-helper suite: node runtime/target-qa/run-qa-tests.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { resolve } from 'node:path';
import {
  analyzeControls,
  compareGroup,
  groupControls,
  tokenLintDiff,
} from './lib/visual-consistency.mjs';

const control = (overrides = {}) => ({
  selector: 'button.btn',
  parentKey: 0,
  parentPath: 'div.row',
  disabled: false,
  iconOnly: false,
  top: 0,
  bottom: 26,
  centerY: 13,
  height: 26,
  fontSize: 12,
  borderRadius: 6,
  paddingLeft: 10,
  paddingRight: 10,
  borderTopWidth: 1,
  focusVisibleOutline: 2,
  ...overrides,
});

test('groupControls keeps side-by-side controls in one row', () => {
  const controls = [
    control({ selector: 'button.a', top: 0, bottom: 26, centerY: 13 }),
    control({ selector: 'button.b', top: 1, bottom: 27, centerY: 14 }),
  ];
  const groups = groupControls(controls);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].controls.length, 2);
});

test('groupControls splits vertically stacked controls into separate rows', () => {
  const controls = [
    control({ selector: 'button.a', top: 0, bottom: 26, centerY: 13 }),
    control({ selector: 'button.b', top: 40, bottom: 66, centerY: 53 }),
  ];
  const groups = groupControls(controls);
  assert.equal(groups.length, 2);
});

test('groupControls groups overlapping controls even when their parents differ', () => {
  const controls = [
    control({ selector: 'button.a', parentKey: 0, parentPath: 'div.a' }),
    control({ selector: 'button.b', parentKey: 1, parentPath: 'div.b', top: 1, bottom: 27, centerY: 14 }),
  ];
  const groups = groupControls(controls);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].controls.length, 2);
});

test('groupControls merges a taller control that overlaps a neighbour band', () => {
  const controls = [
    control({ selector: 'button.a', top: 0, bottom: 26, centerY: 13 }),
    control({ selector: 'button.b', top: 10, bottom: 50, centerY: 30, height: 40 }),
  ];
  const groups = groupControls(controls);
  assert.equal(groups.length, 1);
});

test('groupControls compares a floating control with its overlapping card row', () => {
  const groups = groupControls([
    control({ selector: 'button.card-action' }),
    control({ selector: 'button.floating-action', floating: true, parentKey: 1, parentPath: 'div.overlay', top: 1, bottom: 27, centerY: 14 }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].controls.length, 2);
});

test('analyzeControls reports a mismatched floating control beside a card action', () => {
  const violations = analyzeControls([
    control({ selector: 'button.card-action' }),
    control({ selector: 'button.floating-action', floating: true, parentKey: 1, parentPath: 'div.overlay', top: 1, bottom: 31, centerY: 16, height: 30 }),
  ]);
  const height = violations.find(violation => violation.kind === 'height');
  assert.ok(height, 'the floating control is compared to the overlapping card action');
  assert.deepEqual(height.controls, ['button.card-action', 'button.floating-action']);
});

test('analyzeControls compares mismatched floating controls in one overlay band', () => {
  const violations = analyzeControls([
    control({ selector: 'button.floating-a', floating: true, parentPath: 'div.overlay', height: 26 }),
    control({ selector: 'button.floating-b', floating: true, parentPath: 'div.overlay', top: 1, bottom: 31, centerY: 16, height: 30 }),
  ]);
  assert.ok(violations.some(violation => violation.kind === 'height'));
});

test('groupControls keeps an unrelated floating overlay in a separate band', () => {
  const groups = groupControls([
    control({ selector: 'button.card-action' }),
    control({ selector: 'button.floating-overlay', floating: true, top: 80, bottom: 106, centerY: 93 }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[1].controls.length, 1);
});

test('compareGroup reports a height mismatch with both values', () => {
  const group = groupControls([
    control({ selector: 'button.a', height: 26, bottom: 26 }),
    control({ selector: 'button.b', height: 30, bottom: 30 }),
  ])[0];
  const violations = compareGroup(group);
  const height = violations.find(violation => violation.kind === 'height');
  assert.ok(height, 'a height violation is reported');
  assert.deepEqual(height.values, [26, 30]);
  assert.equal(height.controls.length, 2);
});

test('compareGroup reports a vertical-centre drift', () => {
  const group = groupControls([
    control({ selector: 'button.a', top: 0, bottom: 26, centerY: 13 }),
    control({ selector: 'button.b', top: 5, bottom: 31, centerY: 18 }),
  ])[0];
  const violations = compareGroup(group);
  assert.ok(violations.some(violation => violation.kind === 'vertical-centre'));
});

test('compareGroup compares padding only inside the same control variant', () => {
  const textGroup = groupControls([
    control({ selector: 'button.a', paddingLeft: 10, paddingRight: 10 }),
    control({ selector: 'button.b', paddingLeft: 12, paddingRight: 12 }),
  ])[0];
  assert.ok(compareGroup(textGroup).some(violation => violation.kind === 'padding'));

  const mixedGroup = groupControls([
    control({ selector: 'button.text', height: 26, bottom: 26, paddingLeft: 10, paddingRight: 10 }),
    control({ selector: 'button.icon', height: 26, bottom: 26, iconOnly: true, paddingLeft: 0, paddingRight: 0 }),
  ])[0];
  const mixed = compareGroup(mixedGroup);
  assert.equal(mixed.some(violation => violation.kind === 'padding'), false, 'icon and text controls are not compared on padding');
  assert.equal(mixed.some(violation => violation.kind === 'height'), false);
});

test('compareGroup reports the radius mismatch of a row', () => {
  const group = groupControls([
    control({ selector: 'button.a', borderRadius: 6 }),
    control({ selector: 'span.chip', borderRadius: 999 }),
  ])[0];
  assert.ok(compareGroup(group).some(violation => violation.kind === 'border-radius'));
});

test('analyzeControls flags a control with a zero focus-visible outline', () => {
  const violations = analyzeControls([
    control({ selector: 'button.a', focusVisibleOutline: 0 }),
    control({ selector: 'button.b', focusVisibleOutline: 2 }),
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'focus-visible');
  assert.equal(violations[0].controls[0], 'button.a');
});

test('tokenLintDiff flags added hex and rgb literals', () => {
  const diff = [
    'diff --git a/renderer/src/styles.css b/renderer/src/styles.css',
    '--- a/renderer/src/styles.css',
    '+++ b/renderer/src/styles.css',
    '@@ -1,0 +2,2 @@',
    '+.a { color: #fff; }',
    '+.b { box-shadow: 0 1px 4px rgba(0,0,0,.14); }',
    '-.old { color: #000; }',
    ' .context { color: #123456; }',
    '+.c { background: color-mix(in srgb, var(--primary) 12%, transparent); }',
    '+.d { color: var(--text); }',
  ].join('\n');
  const { violations } = tokenLintDiff(diff);
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map(violation => violation.file), ['renderer/src/styles.css', 'renderer/src/styles.css']);
  assert.deepEqual(violations[0].matches, ['#fff']);
  assert.deepEqual(violations[1].matches, ['rgba(']);
});

test('tokenLintDiff ignores removed and context lines', () => {
  const diff = '+++ b/foo.css\n@@ -1 +1 @@\n-.x { color: #fff; }\n .y { color: #000; }\n+.z { color: var(--text); }';
  assert.deepEqual(tokenLintDiff(diff).violations, []);
});

test('this task adds no new colour literals to CSS', () => {
  const repo = resolve(import.meta.dirname, '..');
  const diff = execFileSync('git', ['diff', '846c272', '--', '*.css'], { cwd: repo, encoding: 'utf8' });
  const { violations } = tokenLintDiff(diff);
  assert.deepEqual(
    violations,
    [],
    `new CSS colour literals since 846c272:\n${violations.map(violation => `${violation.file}:${violation.line} ${violation.content}`).join('\n')}`,
  );
});
